#!/bin/bash
TWILIO_SID="AC054aa32392247949cb3a94008e6d6a0e"
TWILIO_TOKEN="0213161b7e9899db4fa23caeb24d4570"
TWILIO_FROM="+18882574191"
BRIAN_PHONE="+16024027197"
LOG="/var/log/manageai-watchdog.log"

ALERT=0; MSG=""

if [ ! -f /opt/manageai/watchdog.sh ]; then
  ALERT=1; MSG="WATCHDOG DELETED"
elif ! lsattr /opt/manageai/watchdog.sh 2>/dev/null | grep -q "i"; then
  ALERT=1; MSG="WATCHDOG IMMUTABLE FLAG REMOVED"
fi

if ! crontab -l 2>/dev/null | grep -q "watchdog.sh"; then
  ALERT=1; MSG="$MSG | WATCHDOG CRON REMOVED"
  (crontab -l 2>/dev/null; echo "* * * * * /opt/manageai/watchdog.sh") | crontab -
fi

if [ $ALERT -eq 1 ]; then
  TS=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
  curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/Messages.json" \
    -u "$TWILIO_SID:$TWILIO_TOKEN" \
    --data-urlencode "To=$BRIAN_PHONE" \
    --data-urlencode "From=$TWILIO_FROM" \
    --data-urlencode "Body=FRIDAY SECURITY: Watchdog tampered! $MSG $TS" >> $LOG 2>&1
  echo "[$TS] TAMPER: $MSG" >> $LOG
fi
