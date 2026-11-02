#!/bin/sh
cd "$(dirname "$0")" || exit 1
sh ./install.sh
result=$?
printf '\nPress Enter to close. '
read answer
exit "$result"
