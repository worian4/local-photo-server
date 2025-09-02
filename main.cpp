
// main.cpp — modified to store image files in localphotos/img and per-date metadata files in localphotos/shared/*date* or localphotos/personal/*user*/*date*
// Build example:
// g++ main.cpp -o local-photo-server -std=c++17 -lssl -lcrypto -lsqlite3 -largon2 -luuid -pthread

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <sqlite3.h>
#include <argon2.h>
#include <openssl/hmac.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/buffer.h>
#include <uuid/uuid.h>

#include <sys/stat.h>
#include <unistd.h>
#include <fstream>
#include <iostream>
#include <sstream>
#include <chrono>
#include <iomanip>
#include <ctime>
#include <cstdio>
#include <vector>
#include <map>
#include <algorithm>
#include <memory>
#include <cerrno>
#include <string>
#include <cctype>

#include <cstdlib>
#include <ctime> 

using json = nlohmann::json;
using namespace httplib;

struct Config {
    int port = 8080;
    std::string storage_root = "/var/lib/localphotos";
    std::string db_path = "/var/lib/localphotos/metadata.db";
    std::string jwt_secret = "CHANGE_ME_REPLACE_WITH_STRONG_SECRET";
    std::string timezone = "";
    int max_upload_mb = 20;
    int thumb_size = 300;
    bool allow_anonymous_shared = false;
    bool disable_clamav = false;
};

struct AppContext {
    Config cfg;
    sqlite3* db = nullptr;
};

static std::string now_iso() {
    auto now = std::chrono::system_clock::now();
    std::time_t tt = std::chrono::system_clock::to_time_t(now);
    std::tm tm;
    localtime_r(&tt, &tm);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    return std::string(buf);
}
static std::string now_iso_minute() {
    std::string s = now_iso();
    if (s.size() >= 16) return s.substr(0,16); // YYYY-MM-DDTHH:MM
    return s;
}
static std::string date_only(const std::string &iso) {
    if (iso.size() >= 10) return iso.substr(0,10);
    return iso;
}
static bool ensure_dir(const std::string &path) {
    if (path.empty()) return false;
    size_t pos = 0;
    while ((pos = path.find('/', pos+1)) != std::string::npos) {
        std::string sub = path.substr(0, pos);
        if (sub.size() && access(sub.c_str(), F_OK) != 0) {
            if (mkdir(sub.c_str(), 0750) != 0 && errno != EEXIST) return false;
        }
    }
    if (access(path.c_str(), F_OK) != 0) {
        if (mkdir(path.c_str(), 0750) != 0 && errno != EEXIST) return false;
    }
    return true;
}
static std::string sanitize_filename(const std::string &name) {
    std::string out;
    out.reserve(name.size());
    for (char c: name) {
        if ((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.') out.push_back(c);
        else out.push_back('_');
    }
    return out;
}
static std::string gen_uuid() {
    uuid_t u;
    uuid_generate(u);
    char buf[37];
    uuid_unparse_lower(u, buf);
    return std::string(buf);
}
static std::string file_extension(const std::string &name) {
    auto pos = name.rfind('.');
    if (pos == std::string::npos) return "";
    return name.substr(pos+1);
}
static std::string read_file_binary(const std::string &path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) return {};
    ifs.seekg(0, std::ios::end);
    size_t sz = (size_t)ifs.tellg();
    ifs.seekg(0);
    std::string out;
    out.resize(sz);
    ifs.read(&out[0], sz);
    return out;
}
static bool write_file_binary(const std::string &path, const std::string &data) {
    std::ofstream ofs(path, std::ios::binary);
    if (!ofs) return false;
    ofs.write(data.data(), (std::streamsize)data.size());
    return true;
}
static bool write_text_file(const std::string &path, const std::string &txt) {
    std::ofstream ofs(path);
    if (!ofs) return false;
    ofs << txt;
    return true;
}
static bool remove_if_exists(const std::string &path) {
    if (path.empty()) return false;
    if (access(path.c_str(), F_OK) == 0) {
        if (unlink(path.c_str()) != 0) {
            std::cerr << "Warning: unlink failed for " << path << " errno=" << errno << std::endl;
            return false;
        }
    }
    return true;
}
// base64 decode using OpenSSL BIO
static std::string base64_decode_std(const std::string &in) {
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *bmem = BIO_new_mem_buf(in.data(), (int)in.size());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    bmem = BIO_push(b64, bmem);
    std::vector<char> out(in.size());
    int decoded = BIO_read(bmem, out.data(), (int)out.size());
    BIO_free_all(bmem);
    if (decoded <= 0) return {};
    return std::string(out.data(), decoded);
}
static std::string guess_mime_from_path(const std::string &path) {
    auto pos = path.find_last_of('.');
    if (pos == std::string::npos) return "image/jpeg";
    std::string ext = path.substr(pos + 1);
    for (auto &c : ext) c = tolower(c);
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "png") return "image/png";
    if (ext == "gif") return "image/gif";
    if (ext == "webp") return "image/webp";
    if (ext == "bmp") return "image/bmp";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "tiff" || ext == "tif") return "image/tiff";
    return "application/octet-stream";
}
// create thumbnail using ImageMagick `convert`
static bool create_thumbnail(const std::string &src, const std::string &dst, int size) {
    if (size <= 0) return false;
    std::ostringstream cmd;
    cmd << "convert " << "'" << src << "' -auto-orient -resize 'x" << size << "' -strip -quality 85 " << "'" << dst << "'";
    int r = system(cmd.str().c_str());
    return (r == 0);
}

// parse multipart (extracts first file part)
static bool parse_multipart_file(const Request &req,
                                 std::string &out_fieldname,
                                 std::string &out_filename,
                                 std::string &out_content) {
    std::string ct = req.get_header_value("Content-Type");
    if (ct.empty()) return false;
    const std::string boundary_key = "boundary=";
    auto pos = ct.find(boundary_key);
    if (pos == std::string::npos) return false;
    std::size_t start = pos + boundary_key.size();
    std::size_t end = start;
    while (end < ct.size() && ct[end] != ';' && !std::isspace((unsigned char)ct[end])) ++end;
    std::string boundary = ct.substr(start, end - start);
    if (boundary.size() >= 2 && boundary.front() == '"' && boundary.back() == '"')
        boundary = boundary.substr(1, boundary.size()-2);
    if (boundary.empty()) return false;
    std::string marker = std::string("--") + boundary;
    const std::string &body = req.body;
    size_t idx = 0;
    while (true) {
        size_t bstart = body.find(marker, idx);
        if (bstart == std::string::npos) break;
        size_t header_start = bstart + marker.size();
        if (header_start + 2 <= body.size() && body.compare(header_start, 2, "\r\n") == 0) header_start += 2;
        size_t hdr_end = body.find("\r\n\r\n", header_start);
        bool used_crlf = true;
        if (hdr_end == std::string::npos) {
            hdr_end = body.find("\n\n", header_start);
            used_crlf = false;
            if (hdr_end == std::string::npos) break;
        }
        std::string hdrs = body.substr(header_start, hdr_end - header_start);
        std::string name, filename;
        std::istringstream hs(hdrs);
        std::string line;
        while (std::getline(hs, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            std::string lower = line;
            std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c){ return std::tolower(c); });
            if (lower.find("content-disposition:") != std::string::npos) {
                auto name_pos = line.find("name=");
                if (name_pos != std::string::npos) {
                    auto q1 = line.find('"', name_pos);
                    if (q1 != std::string::npos) {
                        auto q2 = line.find('"', q1+1);
                        if (q2 != std::string::npos) name = line.substr(q1+1, q2-q1-1);
                    } else {
                        size_t p = name_pos + 5;
                        size_t q = line.find(';', p);
                        if (q == std::string::npos) q = line.size();
                        name = line.substr(p, q-p);
                        while (!name.empty() && std::isspace((unsigned char)name.front())) name.erase(name.begin());
                        while (!name.empty() && std::isspace((unsigned char)name.back())) name.pop_back();
                    }
                }
                auto fn_pos = line.find("filename=");
                if (fn_pos != std::string::npos) {
                    auto q1 = line.find('"', fn_pos);
                    if (q1 != std::string::npos) {
                        auto q2 = line.find('"', q1+1);
                        if (q2 != std::string::npos) filename = line.substr(q1+1, q2-q1-1);
                    } else {
                        size_t p = fn_pos + 9;
                        size_t q = line.find(';', p);
                        if (q == std::string::npos) q = line.size();
                        filename = line.substr(p, q-p);
                        while (!filename.empty() && std::isspace((unsigned char)filename.front())) filename.erase(filename.begin());
                        while (!filename.empty() && std::isspace((unsigned char)filename.back())) filename.pop_back();
                    }
                }
            }
        }
        size_t data_start = hdr_end + (used_crlf ? 4 : 2);
        size_t next_b = body.find(marker, data_start);
        if (next_b == std::string::npos) break;
        size_t data_end = next_b;
        if (data_end >= 2 && body[data_end-2] == '\r' && body[data_end-1] == '\n') data_end -= 2;
        else if (data_end >= 1 && (body[data_end-1] == '\n' || body[data_end-1] == '\r')) data_end -= 1;
        out_fieldname = name;
        out_filename = filename;
        out_content = body.substr(data_start, data_end - data_start);
        return true;
    }
    return false;
}

// DB helpers
static bool init_db(AppContext &ctx) {
    if (sqlite3_open(ctx.cfg.db_path.c_str(), &ctx.db) != SQLITE_OK) return false;
    const char *sql = R"SQL(
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      pass_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      owner TEXT,
      scope TEXT,
      date TEXT,
      orig_filename TEXT,
      storage_path TEXT,
      thumb_path TEXT,
      meta_path TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date);
    )SQL";
    char *err = nullptr;
    if (sqlite3_exec(ctx.db, sql, 0, 0, &err) != SQLITE_OK) {
        std::cerr << "DB init error: " << (err ? err : "") << std::endl;
        if (err) sqlite3_free(err);
        return false;
    }
    return true;
}
static bool insert_photo_record(AppContext &ctx, const std::string &id, const std::string &owner, const std::string &scope, const std::string &date,
                                const std::string &orig_filename, const std::string &storage_path, const std::string &thumb_path, const std::string &meta_path) {
    sqlite3_stmt *stmt = nullptr;
    const char *sql = "INSERT INTO photos(id,owner,scope,date,orig_filename,storage_path,thumb_path,meta_path,created_at) VALUES(?,?,?,?,?,?,?,?,?);";
    if (sqlite3_prepare_v2(ctx.db, sql, -1, &stmt, NULL) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, owner.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, scope.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, date.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, orig_filename.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, storage_path.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, thumb_path.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, meta_path.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 9, now_iso().c_str(), -1, SQLITE_TRANSIENT);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}
static bool delete_photo_record(AppContext &ctx, const std::string &id) {
    sqlite3_stmt *stmt = nullptr;
    const char *sql = "DELETE FROM photos WHERE id=?;";
    if (sqlite3_prepare_v2(ctx.db, sql, -1, &stmt, NULL) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok;
}
static bool lookup_photo(AppContext &ctx, const std::string &id, std::string &owner, std::string &scope, std::string &storage_path, std::string &thumb_path, std::string &meta_path) {
    sqlite3_stmt *stmt = nullptr;
    const char *sql = "SELECT owner,scope,storage_path,thumb_path,meta_path FROM photos WHERE id=? LIMIT 1;";
    if (sqlite3_prepare_v2(ctx.db, sql, -1, &stmt, NULL) != SQLITE_OK) return false;
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    bool found = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        owner = (const char*)sqlite3_column_text(stmt,0);
        scope = (const char*)sqlite3_column_text(stmt,1);
        storage_path = (const char*)sqlite3_column_text(stmt,2);
        thumb_path = (const char*)sqlite3_column_text(stmt,3);
        meta_path = (const char*)sqlite3_column_text(stmt,4);
        found = true;
    }
    sqlite3_finalize(stmt);
    return found;
}
static json get_blocks(AppContext &ctx, const std::string &scope, const std::string &owner, int start, int count) {
    sqlite3_stmt *stmt = nullptr;
    const char *sql_dates = "SELECT DISTINCT date FROM photos WHERE (scope=? OR (scope='personal' AND owner=?)) ORDER BY date DESC LIMIT ? OFFSET ?;";
    if (sqlite3_prepare_v2(ctx.db, sql_dates, -1, &stmt, NULL) != SQLITE_OK) return {};
    sqlite3_bind_text(stmt, 1, scope.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, owner.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 3, count);
    sqlite3_bind_int(stmt, 4, start);
    json out = json::array();
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const unsigned char *date = sqlite3_column_text(stmt, 0);
        std::string date_s = std::string((const char*)date);
        sqlite3_stmt *ps = nullptr;
        const char *sql_ph = "SELECT id,owner,scope,orig_filename,thumb_path,storage_path,created_at FROM photos WHERE date=? AND (scope=? OR (scope='personal' AND owner=?)) ORDER BY created_at DESC;";
        if (sqlite3_prepare_v2(ctx.db, sql_ph, -1, &ps, NULL) != SQLITE_OK) continue;
        sqlite3_bind_text(ps,1,date_s.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(ps,2,scope.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(ps,3,owner.c_str(),-1,SQLITE_TRANSIENT);
        json block;
        block["date"] = date_s;
        block["photos"] = json::array();
        while (sqlite3_step(ps) == SQLITE_ROW) {
            std::string id = (const char*)sqlite3_column_text(ps,0);
            std::string owner2 = (const char*)sqlite3_column_text(ps,1);
            std::string scope2 = (const char*)sqlite3_column_text(ps,2);
            std::string orig = (const char*)sqlite3_column_text(ps,3);
            std::string thumb = (const char*)sqlite3_column_text(ps,4);
            std::string storage = (const char*)sqlite3_column_text(ps,5);
            std::string created = (const char*)sqlite3_column_text(ps,6);
            json p;
            p["id"] = id;
            p["owner"] = owner2;
            p["scope"] = scope2;
            p["thumb_url"] = std::string("/thumbs/") + id;
            p["full_url"] = std::string("/images/") + id;
            p["orig_name"] = orig;
            p["created_at"] = created;
            block["photos"].push_back(p);
        }
        sqlite3_finalize(ps);
        out.push_back(block);
    }
    sqlite3_finalize(stmt);
    return out;
}

// helper: try to parse metadata JSON from a file
static bool read_json_file(const std::string &path, json &out) {
    std::ifstream ifs(path);
    if (!ifs) return false;
    try {
        ifs >> out;
        return true;
    } catch(...) {
        return false;
    }
}

// JWT HMAC helpers (simplified using OpenSSL EVP APIs)
static std::string base64url_encode(const std::string &input) {
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *bmem = BIO_new(BIO_s_mem());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    b64 = BIO_push(b64, bmem);
    BIO_write(b64, input.data(), (int)input.size());
    BIO_flush(b64);
    BUF_MEM *bptr;
    BIO_get_mem_ptr(b64, &bptr);
    std::string out(bptr->data, bptr->length);
    BIO_free_all(b64);
    for (auto &c: out) if (c=='+') c='-'; else if (c=='/') c='_';
    while (!out.empty() && out.back()=='=') out.pop_back();
    return out;
}
static std::string base64url_decode(const std::string &input) {
    std::string in = input;
    for (auto &c: in) if (c=='-') c='+'; else if (c=='_') c='/';
    while (in.size()%4) in.push_back('=');
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *bmem = BIO_new_mem_buf(in.data(), (int)in.size());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    bmem = BIO_push(b64, bmem);
    std::vector<char> out(in.size());
    int decoded = BIO_read(bmem, out.data(), (int)out.size());
    BIO_free_all(bmem);
    if (decoded <= 0) return {};
    return std::string(out.data(), decoded);
}
static std::string hmac_sha256_hex(const std::string &key, const std::string &data) {
    unsigned char result[EVP_MAX_MD_SIZE];
    size_t len = 0;
    EVP_MAC *mac = EVP_MAC_fetch(NULL, "HMAC", NULL);
    EVP_MAC_CTX *ctx = EVP_MAC_CTX_new(mac);
    OSSL_PARAM params[2] = {
        OSSL_PARAM_construct_utf8_string("digest", const_cast<char*>("SHA256"), 0),
        OSSL_PARAM_construct_end()
    };
    EVP_MAC_init(ctx, (const unsigned char*)key.data(), key.size(), params);
    EVP_MAC_update(ctx, (const unsigned char*)data.data(), data.size());
    EVP_MAC_final(ctx, result, &len, sizeof(result));
    EVP_MAC_CTX_free(ctx);
    EVP_MAC_free(mac);
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (size_t i = 0; i < len; ++i) oss << std::setw(2) << (int)result[i];
    return oss.str();
}
static std::string make_jwt(const AppContext &ctx, const std::string &username, int ttl_seconds=3600) {
    json header = { {"alg","HS256"}, {"typ","JWT"} };
    int iat = (int)std::time(nullptr);
    json payload = { {"sub", username}, {"iat", iat}, {"exp", iat + ttl_seconds} };
    std::string header_b = base64url_encode(header.dump());
    std::string payload_b = base64url_encode(payload.dump());
    std::string signing_input = header_b + "." + payload_b;
    std::string sig_hex = hmac_sha256_hex(ctx.cfg.jwt_secret, signing_input);
    return signing_input + "." + sig_hex;
}
static bool verify_jwt(const AppContext &ctx, const std::string &token, std::string &username_out) {
    auto pos = token.rfind('.');
    if (pos == std::string::npos) return false;
    auto signing_input = token.substr(0,pos);
    auto sig = token.substr(pos+1);
    auto expected = hmac_sha256_hex(ctx.cfg.jwt_secret, signing_input);
    if (expected != sig) return false;
    auto pos2 = signing_input.find('.');
    if (pos2 == std::string::npos) return false;
    auto payload_b64 = signing_input.substr(pos2+1);
    std::string payload = base64url_decode(payload_b64);
    try {
        auto j = json::parse(payload);
        if (!j.contains("sub") || !j.contains("exp")) return false;
        username_out = j["sub"].get<std::string>();
        int exp = j["exp"].get<int>();
        if (std::time(nullptr) > exp) return false;
        return true;
    } catch(...) { return false; }
}

int main(int argc, char **argv) {
    std::string config_path;
    for (int i=1;i<argc;i++) {
        std::string a = argv[i];
        if (a == "--config" && i+1<argc) { config_path = argv[++i]; }
    }
    if (config_path.empty()) {
        std::cerr << "Usage: " << argv[0] << " --config ./config.json\n";
        return 1;
    }
    std::ifstream ifs(config_path);
    if (!ifs) { std::cerr << "Cannot open config: " << config_path << std::endl; return 1; }
    json jc;
    try { ifs >> jc; } catch(...) { std::cerr << "Invalid JSON config\n"; return 1; }
    AppContext ctx;
    if (jc.contains("server_port")) ctx.cfg.port = jc["server_port"].get<int>();
    if (jc.contains("storage_root")) ctx.cfg.storage_root = jc["storage_root"].get<std::string>();
    if (jc.contains("db_path")) ctx.cfg.db_path = jc["db_path"].get<std::string>();
    if (jc.contains("jwt_secret")) ctx.cfg.jwt_secret = jc["jwt_secret"].get<std::string>();
    if (jc.contains("max_upload_mb")) ctx.cfg.max_upload_mb = jc["max_upload_mb"].get<int>();
    if (jc.contains("thumbnail_size")) ctx.cfg.thumb_size = jc["thumbnail_size"].get<int>();
    if (jc.contains("allow_anonymous_shared")) ctx.cfg.allow_anonymous_shared = jc["allow_anonymous_shared"].get<bool>();
    if (jc.contains("disable_clamav")) ctx.cfg.disable_clamav = jc["disable_clamav"].get<bool>();

    if (!ctx.cfg.timezone.empty()) {
        setenv("TZ", ctx.cfg.timezone.c_str(), 1);
        tzset();
    }

    ensure_dir(ctx.cfg.storage_root);
    ensure_dir(ctx.cfg.storage_root + "/shared");
    ensure_dir(ctx.cfg.storage_root + "/personal");
    ensure_dir(ctx.cfg.storage_root + "/img");
    ensure_dir(ctx.cfg.storage_root + "/thumbs");
    if (!init_db(ctx)) { std::cerr << "DB init failed\n"; return 1; }

    Server svr;
    svr.set_payload_max_length(ctx.cfg.max_upload_mb * 1024 * 1024);
    svr.set_mount_point("/", "./web");

    // login
    svr.Post("/api/login", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        try {
            auto j = json::parse(req.body);
            std::string username = j.value("username","");
            std::string password = j.value("password","");
            if (username.empty() || password.empty()) { res.status = 400; res.set_content("{\"error\":\"missing\"}","application/json"); return; }
            sqlite3_stmt *stmt = nullptr;
            const char *sql = "SELECT pass_hash FROM users WHERE username=? LIMIT 1;";
            if (sqlite3_prepare_v2(context.db, sql, -1, &stmt, NULL) != SQLITE_OK) { res.status=500; return; }
            sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
            if (sqlite3_step(stmt) != SQLITE_ROW) { sqlite3_finalize(stmt); res.status = 401; res.set_content("{\"error\":\"invalid\"}","application/json"); return; }
            std::string pass_hash = (const char*)sqlite3_column_text(stmt,0);
            sqlite3_finalize(stmt);
            // verify password using argon2 (assumes encoded PHC string stored)
            int rc = argon2_verify(pass_hash.c_str(), password.c_str(), password.size(), Argon2_id);
            if (rc != ARGON2_OK) { res.status=401; res.set_content("{\"error\":\"invalid\"}","application/json"); return; }
            std::string token = make_jwt(context, username, 3600);
            json out = { {"token", token}, {"expires_in", 3600} };
            res.set_content(out.dump(), "application/json");
        } catch(...) { res.status = 400; res.set_content("{\"error\":\"bad_request\"}","application/json"); }
    });

    // --- upload handler: accepts multipart/form-data or JSON(base64) ---
    svr.Post("/api/upload", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        std::string auth = req.get_header_value("Authorization");
        std::string username;
        bool authed = false;
        if (!auth.empty() && auth.rfind("Bearer ",0)==0) {
            std::string token = auth.substr(7);
            if (verify_jwt(context, token, username)) authed = true;
        }
        std::string scope = "personal";
        if (req.has_param("scope")) scope = req.get_param_value("scope");
        if (scope != "personal" && scope != "shared") { res.status=400; res.set_content("{\"error\":\"bad_scope\"}","application/json"); return; }
        if (scope == "personal" && !authed) { res.status=401; res.set_content("{\"error\":\"auth_required\"}","application/json"); return; }
        if (scope == "shared" && !authed && !context.cfg.allow_anonymous_shared) { res.status=401; res.set_content("{\"error\":\"auth_required\"}","application/json"); return; }

        std::string filename;
        std::string filecontent;
        bool got = false;
        // Try multipart form file
        try {
            if (parse_multipart_file(req, filename, filename, filecontent)) {
                got = true;
            }
        } catch(...) { /* ignore */ }
        // Try JSON with base64
        if (!got) {
            try {
                auto j = json::parse(req.body);
                if (j.contains("filename") && j.contains("data")) {
                    filename = j["filename"].get<std::string>();
                    std::string b64 = j["data"].get<std::string>();
                    filecontent = base64_decode_std(b64);
                    got = !filecontent.empty();
                }
            } catch(...) { /* ignore */ }
        }
        if (!got) {
            res.status = 400;
            res.set_content("{\"error\":\"no_file\"}", "application/json");
            return;
        }

        std::string orig_name = sanitize_filename(filename);
        if (orig_name.empty()) orig_name = "file";
        std::string ext = file_extension(orig_name);
        if (ext.size() > 8) ext = "";
        std::string created = now_iso();
        std::string date = date_only(created);
        std::string id = gen_uuid();

        // ensure img dir
        std::string img_dir = context.cfg.storage_root + "/img";
        if (!ensure_dir(img_dir)) { res.status=500; res.set_content("{\"error\":\"fs\"}","application/json"); return; }

        // write image into img folder with unique name
        std::string filename_out = id + (ext.empty() ? "" : std::string(".") + ext);
        std::string img_fullpath = img_dir + "/" + filename_out;
        if (!write_file_binary(img_fullpath, filecontent)) { res.status=500; res.set_content("{\"error\":\"write_fail\"}","application/json"); return; }
        chmod(img_fullpath.c_str(), 0640);

        // generate thumbnail into img folder as well
        std::string thumb_name = id + ".thumb.jpg";
        std::string thumb_fullpath = img_dir + "/" + thumb_name;
        if (!create_thumbnail(img_fullpath, thumb_fullpath, context.cfg.thumb_size)) {
            std::cerr << "Warning: thumbnail generation failed for " << img_fullpath << std::endl;
        } else {
            chmod(thumb_fullpath.c_str(), 0640);
        }

        // create per-date metadata file in shared or personal/date dir
        std::string subdir = (scope=="personal") ? (std::string("personal/") + (authed?username:"unknown") + "/" + date) : (std::string("shared/") + date);
        std::string meta_dir = context.cfg.storage_root + "/" + subdir;
        if (!ensure_dir(meta_dir)) { /* try to continue */ }
        json meta = {
            {"id", id},
            {"img", std::string("img/") + filename_out},
            {"thumb", std::string("img/") + thumb_name},
            {"orig_name", orig_name},
            {"owner", authed?username:""},
            {"scope", scope},
            {"time", now_iso_minute()}
        };
        std::string meta_path = meta_dir + "/" + id + ".json";
        if (!write_text_file(meta_path, meta.dump())) {
            // best-effort: remove img/thumb then fail
            remove_if_exists(img_fullpath);
            remove_if_exists(thumb_fullpath);
            res.status=500; res.set_content("{\"error\":\"meta_write_failed\"}", "application/json");
            return;
        }
        chmod(meta_path.c_str(), 0640);

        // store record in DB (storage_path and thumb_path point to real files)
        if (!insert_photo_record(context, id, authed?username:"", scope, date, orig_name, img_fullpath, thumb_fullpath, meta_path)) {
            remove_if_exists(img_fullpath);
            remove_if_exists(thumb_fullpath);
            remove_if_exists(meta_path);
            res.status=500; res.set_content("{\"error\":\"db\"}", "application/json");
            return;
        }

        json out = { {"status","ok"}, {"id", id}, {"thumb_url", std::string("/thumbs/") + id}, {"full_url", std::string("/images/") + id} };
        res.set_content(out.dump(), "application/json");
    });

    // blocks endpoint (unchanged, reads DB)
    svr.Get(R"(/api/blocks)", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        std::string scope = req.get_param_value("scope") != "" ? req.get_param_value("scope") : "shared";
        int start = 0; if (req.has_param("start")) start = std::stoi(req.get_param_value("start"));
        int count = 5; if (req.has_param("count")) count = std::stoi(req.get_param_value("count"));
        std::string auth = req.get_header_value("Authorization");
        std::string username;
        std::string token;
        if (auth.rfind("Bearer ",0) == 0) {
            token = auth.substr(7);
            verify_jwt(context, token, username);
        } else if (req.has_param("t")) {
            token = req.get_param_value("t");
            verify_jwt(context, token, username);
        }
        if (!username.empty() && token.empty()) {
            token = make_jwt(context, username);
        }

        if (scope == "personal") {
            if (username.empty()) { res.status=401; res.set_content("{\"error\":\"auth_required\"}","application/json"); return; }
            // Build blocks only for this owner to ensure other users cannot see personal photos
            json out = json::array();
            sqlite3_stmt *stmt = nullptr;
            const char *sql_dates = "SELECT DISTINCT date FROM photos WHERE scope='personal' AND owner=? ORDER BY date DESC LIMIT ? OFFSET ?;";
            if (sqlite3_prepare_v2(context.db, sql_dates, -1, &stmt, NULL) == SQLITE_OK) {
                sqlite3_bind_text(stmt,1, username.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(stmt,2, count);
                sqlite3_bind_int(stmt,3, start);
                while (sqlite3_step(stmt) == SQLITE_ROW) {
                    const unsigned char *date = sqlite3_column_text(stmt,0);
                    std::string date_s = std::string((const char*)date);
                    sqlite3_stmt *ps = nullptr;
                    const char *sql_ph = "SELECT id,owner,scope,orig_filename,thumb_path,storage_path,created_at FROM photos WHERE date=? AND scope='personal' AND owner=? ORDER BY created_at DESC;";
                    if (sqlite3_prepare_v2(context.db, sql_ph, -1, &ps, NULL) == SQLITE_OK) {
                        sqlite3_bind_text(ps,1,date_s.c_str(), -1, SQLITE_TRANSIENT);
                        sqlite3_bind_text(ps,2,username.c_str(), -1, SQLITE_TRANSIENT);
                        json block;
                        block["date"] = date_s;
                        block["photos"] = json::array();
                        while (sqlite3_step(ps) == SQLITE_ROW) {
                            json p;
                            p["id"] = std::string((const char*)sqlite3_column_text(ps,0));
                            p["owner"] = std::string((const char*)sqlite3_column_text(ps,1));
                            p["scope"] = std::string((const char*)sqlite3_column_text(ps,2));
                            p["orig_name"] = std::string((const char*)sqlite3_column_text(ps,3));
                            std::string id = std::string((const char*)sqlite3_column_text(ps,0));
                            p["thumb_url"] = std::string("/thumbs/") + id;
                            p["full_url"] = std::string("/images/") + id;
                            if (!token.empty()) {
                                p["thumb_url"] = p["thumb_url"].get<std::string>() + std::string("?t=") + token;
                                p["full_url"] = p["full_url"].get<std::string>() + std::string("?t=") + token;
                            }
                            p["created_at"] = std::string((const char*)sqlite3_column_text(ps,6));
                            block["photos"].push_back(p);
                        }
                        sqlite3_finalize(ps);
                        out.push_back(block);
                    }
                }
                sqlite3_finalize(stmt);
            }
            res.set_content(out.dump(), "application/json");
            return;
        }
        
        json blocks = get_blocks(context, scope, std::string(""), start, count);
        res.set_content(blocks.dump(), "application/json");
    });


    // GET photo metadata (returns JSON with owner, time (minute precision), urls)
    svr.Get(R"(/api/photo/(.*))", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        std::string id = req.matches[1].str();
        std::string owner, scope, storage_path, thumb_path, meta_path;
        if (!lookup_photo(context, id, owner, scope, storage_path, thumb_path, meta_path)) {
            res.status = 404;
            res.set_content("{\"error\":\"not_found\"}", "application/json");
            return;
        }

        // If photo is personal, require authentication and owner match
        if (scope == "personal") {
            std::string auth = req.get_header_value("Authorization");
            std::string username;
            if (auth.rfind("Bearer ",0) != 0 || !verify_jwt(context, auth.substr(7), username) || username != owner) {
                res.status = 403;
                res.set_content("{\"error\":\"forbidden\"}", "application/json");
                return;
            }
        }

        json out;
        out["id"] = id;
        out["full_url"] = std::string("/images/") + id;
        out["thumb_url"] = std::string("/thumbs/") + id;
        out["owner"] = owner;
        out["scope"] = scope;

        // try to enrich response from meta file (preferred)
        if (!meta_path.empty() && access(meta_path.c_str(), R_OK) == 0) {
            json m;
            if (read_json_file(meta_path, m)) {
                if (m.contains("time")) out["time"] = m["time"];
                if (m.contains("orig_name")) out["orig_name"] = m["orig_name"];
            }
        }

        // if metadata file did not contain time, try to derive it from file mtime (minute precision)
        if (!out.contains("time") && !storage_path.empty()) {
            struct stat st;
            if (stat(storage_path.c_str(), &st) == 0) {
                std::time_t mt = st.st_mtime;
                std::tm tm;
                localtime_r(&mt, &tm);
                char buf[32];
                std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M", &tm);
                out["time"] = std::string(buf);
            }
        }

        res.set_content(out.dump(), "application/json");
    });
    // thumbs
    svr.Get(R"(/thumbs/(.*))", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        std::string id = req.matches[1].str();
        std::string owner, scope, storage_path, thumb_path, meta_path;
        if (!lookup_photo(context, id, owner, scope, storage_path, thumb_path, meta_path)) { res.status=404; return; }
        // If thumbnail/image belongs to a personal photo, require auth and owner match.
                if (scope == "personal") {
            std::string token;
            std::string auth = req.get_header_value("Authorization");
            if (auth.rfind("Bearer ",0) == 0) token = auth.substr(7);
            else if (req.has_param("t")) token = req.get_param_value("t");
            else {
                // try to extract token from Cookie header (common names: token, auth)
                std::string cookie = req.get_header_value("Cookie");
                if (!cookie.empty()) {
                    auto findCookie = [&](const std::string &name)->std::string {
                        size_t p = cookie.find(name + "=");
                        if (p == std::string::npos) return std::string();
                        size_t start = p + name.size() + 1;
                        size_t q = cookie.find(";", start);
                        if (q == std::string::npos) q = cookie.size();
                        return cookie.substr(start, q - start);
                    };
                    std::string c = findCookie("token");
                    if (c.empty()) c = findCookie("auth");
                    if (c.empty()) c = findCookie("t");
                    if (!c.empty()) token = c;
                }
            }
            std::string username;
            if (token.empty() || !verify_jwt(context, token, username) || username != owner) {
                res.status = 403;
                res.set_content("{\"error\":\"forbidden\"}", "application/json");
                return;
            }
        }

std::string data;
        std::string source_path;
        if (!thumb_path.empty() && access(thumb_path.c_str(), R_OK) == 0) {
            data = read_file_binary(thumb_path);
            source_path = thumb_path;
        } else if (access(storage_path.c_str(), R_OK) == 0) {
            data = read_file_binary(storage_path);
            source_path = storage_path;
        } else {
            res.status = 404; return;
        }
        if (data.empty()) { res.status = 500; return; }
        std::string mime = guess_mime_from_path(source_path);
        res.set_content(data, mime.c_str());
    });

    // images
    svr.Get(R"(/images/(.*))", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        std::string id = req.matches[1].str();
        std::string owner, scope, storage_path, thumb_path, meta_path;
        if (!lookup_photo(context, id, owner, scope, storage_path, thumb_path, meta_path)) { res.status=404; return; }
                if (scope == "personal") {
            std::string token;
            std::string auth = req.get_header_value("Authorization");
            if (auth.rfind("Bearer ",0) == 0) token = auth.substr(7);
            else if (req.has_param("t")) token = req.get_param_value("t");
            else {
                // try to extract token from Cookie header (common names: token, auth)
                std::string cookie = req.get_header_value("Cookie");
                if (!cookie.empty()) {
                    auto findCookie = [&](const std::string &name)->std::string {
                        size_t p = cookie.find(name + "=");
                        if (p == std::string::npos) return std::string();
                        size_t start = p + name.size() + 1;
                        size_t q = cookie.find(";", start);
                        if (q == std::string::npos) q = cookie.size();
                        return cookie.substr(start, q - start);
                    };
                    std::string c = findCookie("token");
                    if (c.empty()) c = findCookie("auth");
                    if (c.empty()) c = findCookie("t");
                    if (!c.empty()) token = c;
                }
            }
            std::string username;
            if (token.empty() || !verify_jwt(context, token, username) || username != owner) {
                res.status = 403;
                res.set_content("{\"error\":\"forbidden\"}", "application/json");
                return;
            }
        }

        std::string data;
        if (access(storage_path.c_str(), R_OK) == 0) {
            data = read_file_binary(storage_path);
        } else if (!thumb_path.empty() && access(thumb_path.c_str(), R_OK) == 0) {
            data = read_file_binary(thumb_path);
        } else {
            res.status = 404; return;
        }
        if (data.empty()) { res.status=500; return; }
        std::string mime = guess_mime_from_path(storage_path);
        res.set_header("Access-Control-Allow-Origin", "*");
        res.set_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:;");
        res.set_content(data, mime.c_str());
    });


    // DELETE photo: open meta file (if present), delete referenced img and thumb, delete meta file, then delete DB record
    svr.Delete(R"(/api/photo/(.*))", [ctxPtr=std::make_shared<AppContext>(ctx)](const Request &req, Response &res) {
        auto &context = *ctxPtr;
        std::string id = req.matches[1].str();
        std::string owner, scope, storage_path, thumb_path, meta_path;
        if (!lookup_photo(context, id, owner, scope, storage_path, thumb_path, meta_path)) {
            res.status = 404;
            res.set_content("{\"error\":\"not_found\"}", "application/json");
            return;
        }

        std::string auth = req.get_header_value("Authorization");
        std::string username;
        if (auth.rfind("Bearer ",0) != 0 || !verify_jwt(context, auth.substr(7), username)) {
            res.status = 401;
            res.set_content("{\"error\":\"auth_required\"}", "application/json");
            return;
        }
        if (!owner.empty() && username != owner) {
            res.status = 403;
            res.set_content("{\"error\":\"forbidden\"}", "application/json");
            return;
        }
        if (owner.empty()) {
            res.status = 403;
            res.set_content("{\"error\":\"forbidden_anonymous\"}", "application/json");
            return;
        }

        // If meta_path exists, prefer to read it
        if (!meta_path.empty() && access(meta_path.c_str(), R_OK) == 0) {
            json m;
            if (read_json_file(meta_path, m)) {
                if (m.contains("img")) {
                    std::string img_rel = m["img"].get<std::string>();
                    std::string img_full = context.cfg.storage_root + "/" + img_rel;
                    remove_if_exists(img_full);
                }
                if (m.contains("thumb")) {
                    std::string thumb_rel = m["thumb"].get<std::string>();
                    std::string thumb_full = context.cfg.storage_root + "/" + thumb_rel;
                    remove_if_exists(thumb_full);
                }
                // remove the meta file itself
                remove_if_exists(meta_path);
            } else {
                // fallback: remove storage_path & thumb_path
                remove_if_exists(storage_path);
                remove_if_exists(thumb_path);
                // try to remove meta_path anyway
                remove_if_exists(meta_path);
            }
        } else {
            // fallback
            remove_if_exists(storage_path);
            remove_if_exists(thumb_path);
        }

        if (!delete_photo_record(context, id)) {
            res.status = 500;
            res.set_content("{\"error\":\"db_delete_failed\"}", "application/json");
            return;
        }

        res.set_content("{\"status\":\"ok\"}", "application/json");
    });

    std::cout << "Server started on port " << ctx.cfg.port << "..." << std::endl;
    svr.listen("0.0.0.0", ctx.cfg.port);
    if (ctx.db) sqlite3_close(ctx.db);
    return 0;
}
