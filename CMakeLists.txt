cmake_minimum_required(VERSION 3.16)
project(local-photo-server VERSION 1.0 LANGUAGES CXX)

# Options
option(USE_SYSTEM_HTTPLIB "Use system-installed cpp-httplib instead of server/third_party/httplib.h" OFF)
option(USE_SYSTEM_NLOHMANN "Use system-installed nlohmann_json instead of server/third_party/json.hpp" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Where to look for third-party headers shipped with the project
set(THIRD_PARTY_DIR ${CMAKE_SOURCE_DIR}/server/third_party)

# Include directories
include_directories(${CMAKE_SOURCE_DIR}/web) # for convenience when bundling web files
if(NOT USE_SYSTEM_HTTPLIB)
  include_directories(${THIRD_PARTY_DIR})
endif()
if(NOT USE_SYSTEM_NLOHMANN)
  include_directories(${THIRD_PARTY_DIR})
endif()

# Add executable sources
set(SERVER_SOURCES
    ${CMAKE_SOURCE_DIR}/server/main.cpp
)

set(CREATE_USER_SOURCES
    ${CMAKE_SOURCE_DIR}/server/create_user.cpp
)

# Find packages
find_package(OpenSSL REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(SQLITE3 sqlite3)
if(SQLITE3_FOUND)
  message(STATUS "Found sqlite3 via pkg-config")
  include_directories(${SQLITE3_INCLUDE_DIRS})
  link_libraries(${SQLITE3_LIBRARIES})
else()
  find_package(SQLite3 REQUIRED)
endif()

# Try to find argon2 via pkg-config, fallback to find_library
pkg_check_modules(ARGON2 argon2)
if(ARGON2_FOUND)
  message(STATUS "Found argon2 via pkg-config")
  include_directories(${ARGON2_INCLUDE_DIRS})
  set(ARGON2_LIBS ${ARGON2_LIBRARIES})
else()
  find_library(ARGON2_LIB NAMES argon2)
  if(ARGON2_LIB)
    set(ARGON2_LIBS ${ARGON2_LIB})
  endif()
endif()

# uuid
find_library(LIBUUID uuid)
if(NOT LIBUUID)
  message(WARNING "libuuid not found via find_library; ensure -luuid is available on your system")
endif()

# Build server executable
add_executable(local-photo-server ${SERVER_SOURCES})
target_include_directories(local-photo-server PRIVATE ${CMAKE_SOURCE_DIR}/server)
# Link libraries
target_link_libraries(local-photo-server PRIVATE OpenSSL::Crypto)
if(ARGON2_LIBS)
  target_link_libraries(local-photo-server PRIVATE ${ARGON2_LIBS})
endif()
if(LIBUUID)
  target_link_libraries(local-photo-server PRIVATE ${LIBUUID})
else()
  target_link_libraries(local-photo-server PRIVATE uuid)
endif()
# sqlite (prefer pkg-config libs or system)
if(SQLITE3_FOUND)
  target_link_libraries(local-photo-server PRIVATE ${SQLITE3_LIBRARIES})
else()
  target_link_libraries(local-photo-server PRIVATE SQLite::SQLite3)
endif()
# fallback libs
target_link_libraries(local-photo-server PRIVATE ssl crypto pthread)

# Build create_user utility
add_executable(create_user ${CREATE_USER_SOURCES})
target_include_directories(create_user PRIVATE ${CMAKE_SOURCE_DIR}/server)
if(ARGON2_LIBS)
  target_link_libraries(create_user PRIVATE ${ARGON2_LIBS})
endif()
if(LIBUUID)
  target_link_libraries(create_user PRIVATE ${LIBUUID})
else()
  target_link_libraries(create_user PRIVATE uuid)
endif()
if(SQLITE3_FOUND)
  target_link_libraries(create_user PRIVATE ${SQLITE3_LIBRARIES})
else()
  target_link_libraries(create_user PRIVATE SQLite::SQLite3)
endif()
target_link_libraries(create_user PRIVATE OpenSSL::Crypto pthread)

# Compiler warnings and sanitizers (opt-in)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(local-photo-server PRIVATE -Wall -Wextra -Wpedantic -Wno-unused-parameter)
  target_compile_options(create_user PRIVATE -Wall -Wextra -Wpedantic -Wno-unused-parameter)
endif()

# Install rules
install(TARGETS local-photo-server create_user
        RUNTIME DESTINATION bin)

# Packaging: embed web folder into build tree (optional)
add_custom_target(copy_web ALL
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/web ${CMAKE_BINARY_DIR}/web
  COMMENT "Copying web files to build directory"
)

add_dependencies(local-photo-server copy_web)

# Helpful messages
message(STATUS "Configuration summary:")
message(STATUS "  USE_SYSTEM_HTTPLIB = ${USE_SYSTEM_HTTPLIB}")
message(STATUS "  USE_SYSTEM_NLOHMANN = ${USE_SYSTEM_NLOHMANN}")
message(STATUS "  Third-party headers expected in: ${THIRD_PARTY_DIR}")
message(STATUS "To build: mkdir build && cd build && cmake .. && make -j")
