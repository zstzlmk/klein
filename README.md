Run /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=~/chrome-dev-session

then: node script.js

To open a Chrome dev session on Windows, run this in PowerShell (not WSL):

& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\chrome-dev-session"

Mac path: /Users/Max/Pictures/kleinanzeigen