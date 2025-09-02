// create_user.cpp
// Утилита для создания пользователя с Argon2id хэшем и занесением в sqlite DB.
// Компиляция: g++ create_user.cpp -o create_user -lsqlite3 -largon2
// Требует libargon2-dev и sqlite3-dev

#include <iostream>
#include <string>
#include <vector>
#include <fstream>
#include <sqlite3.h>
#include <argon2.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>

static std::string read_password(const char* prompt) {
    std::cout << prompt;
    termios oldt;
    tcgetattr(STDIN_FILENO, &oldt);
    termios newt = oldt;
    newt.c_lflag &= ~ECHO;
    tcsetattr(STDIN_FILENO, TCSANOW, &newt);
    std::string pwd;
    std::getline(std::cin, pwd);
    tcsetattr(STDIN_FILENO, TCSANOW, &oldt);
    std::cout << "\n";
    return pwd;
}

static bool random_bytes(unsigned char* buf, size_t len) {
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return false;
    ssize_t r = read(fd, buf, len);
    close(fd);
    return r == (ssize_t)len;
}

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0] << " <db_path> <username>\n";
        return 1;
    }
    const char* db_path = argv[1];
    const char* username = argv[2];

    // read password twice
    std::string pass1 = read_password("Enter password: ");
    std::string pass2 = read_password("Repeat password: ");
    if (pass1 != pass2) {
        std::cerr << "Passwords do not match\n";
        return 1;
    }

    // Argon2 parameters (t_cost, m_cost KB, parallelism)
    uint32_t t_cost = 2;
    uint32_t m_cost = 1 << 16; // 65536 KB = 64 MB
    uint32_t parallelism = 1;
    uint32_t hashlen = 32;
    const argon2_type type = Argon2_id;
    const uint32_t version = ARGON2_VERSION_NUMBER;

    // generate salt
    const size_t saltlen = 16;
    std::vector<unsigned char> salt(saltlen);
    if (!random_bytes(salt.data(), saltlen)) {
        std::cerr << "Failed to get random bytes for salt\n";
        return 1;
    }

    // allocate encoded buffer sufficient length
    size_t encoded_len = 512;
    std::vector<char> encoded(encoded_len);

    int rc = argon2_hash(t_cost, m_cost, parallelism,
                         pass1.c_str(), pass1.size(),
                         salt.data(), saltlen,
                         NULL, hashlen,
                         encoded.data(), encoded_len,
                         type, version);

    if (rc != ARGON2_OK) {
        std::cerr << "argon2_hash failed: " << argon2_error_message(rc) << "\n";
        return 1;
    }

    // encoded now contains "encoded" raw hash in PHC string format
    std::string encoded_str(encoded.data());

    // Open sqlite and insert
    sqlite3* db = nullptr;
    if (sqlite3_open(db_path, &db) != SQLITE_OK) {
        std::cerr << "Failed to open DB: " << sqlite3_errmsg(db) << "\n";
        return 1;
    }

    const char* sql_create = "CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL);";
    char* err = nullptr;
    if (sqlite3_exec(db, sql_create, 0, 0, &err) != SQLITE_OK) {
        std::cerr << "DB init error: " << (err ? err : "") << "\n";
        if (err) sqlite3_free(err);
        sqlite3_close(db);
        return 1;
    }

    const char* sql_insert = "INSERT OR REPLACE INTO users(username, pass_hash) VALUES(?, ?);";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql_insert, -1, &stmt, NULL) != SQLITE_OK) {
        std::cerr << "Prepare failed: " << sqlite3_errmsg(db) << "\n";
        sqlite3_close(db);
        return 1;
    }

    sqlite3_bind_text(stmt, 1, username, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, encoded_str.c_str(), -1, SQLITE_TRANSIENT);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        std::cerr << "Insert failed: " << sqlite3_errmsg(db) << "\n";
        sqlite3_finalize(stmt);
        sqlite3_close(db);
        return 1;
    }

    sqlite3_finalize(stmt);
    sqlite3_close(db);

    std::cout << "User '" << username << "' created/updated successfully.\n";
    return 0;
}