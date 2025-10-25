# local-photo-server
A program you can run to upload and share photos from your server, a simple analogue to Google Photos/

I've tested it only on a Linux server, so Linux is more apropriate to be run on, but you can try to run it on Windows too.

How to run: after you've built the program, in your folder where is built program located (diffrent in ```CMakePresets.json```) you execute this:
```
./local-photo-server --config ~/local-photo-server/server/config.json
```
or wherever your program and ```config.json``` is located. This will create a ```localphotos``` folder where all the data will be contained. After you've done that you'd like to create a user, as I haven't made user creation in terms of safety. so, to create user run from the same folder:
```
./create_user ~/local-photo-server/localphotos/metadata.db *username*
```
so once you've managed to follow those steps, the site is already running, so you can just type ```*youreserverip/port```. You can always change the port in ```config.json```, but ```8080``` is put by default. At the site, you can choose wheather to upload files to shared ("Общее"), those photos could see any users of your wifi (even that are not registred), or private ("Мое"), those can see only you (and the server administrator, of coarse:>). Everething else is user friendly, it's easily to get along, so youre free to go!

## Installation:
1. Install C++, gcc, g++ and Ninja on your server.
2. To install all libraries, execute:
```
sudo apt install -y build-essential cmake pkg-config libssl-dev libsqlite3-dev libargon2-dev uuid-dev imagemagick clamav-daemon
```
3. Download the git.
4. I've compiled it with VS Code, but you can also build it from terminal. If youre also using VS Code, choose youre preset in ```CMakePresets.json``` and build.
5. Follow the "How to run" steps to start the server.
6. Enjoy!
