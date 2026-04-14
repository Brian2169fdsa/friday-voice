#!/bin/bash
# ManageAI Server Watchdog v2 — auto-kill rogue processes + SMS to Brian
LOG="/var/log/manageai-watchdog.log"
CPU_THRESHOLD=800
SAFE_PROCS="dockerd|containerd|clickhouse|java|node|claude|nginx|redis|php|puma|temporal|postgres|beam|ttyd|ruby|rails|runc|git|ps|awk|grep|sort|curl|python|sidekiq|horizon|caddy|ssh|bash|sh|cron|systemd|docker-proxy|containerd-shim"

TWILIO_SID="REPLACE_WITH_TWILIO_SID"
TWILIO_TOKEN="REPLACE_WITH_TWILIO_TOKEN"
TWILIO_FROM="+18882574191"
BRIAN_PHONE="+16024027197"

# Only flag processes in /tmp (the actual attack pattern)
TMP_PROCS=$(ps aux | grep -E "/tmp/[a-z]" | grep -v grep | grep -v watchdog | awk '{print $2"|"$1"|"$3"|"$11}')

# Flag unknown processes over threshold that aren't whitelisted
ROGUES=$(ps aux --sort=-%cpu | awk -v thresh=$CPU_THRESHOLD -v safe="$SAFE_PROCS" '
  NR>1 && $3>thresh {
    cmd=$11; for(i=12;i<=NF;i++) cmd=cmd" "$i
    skip=0; split(safe,a,"|"); for(k in a) if(cmd~a[k]) skip=1
    if(!skip) print $2"|"$1"|"$3"|"cmd
  }')

KILL_LIST=$(echo -e "$TMP_PROCS\n$ROGUES" | grep -v "^$" | sort -u)

if [ -n "$KILL_LIST" ]; then
  TS=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
  LOAD=$(awk '{print $1}' /proc/loadavg)
  echo "[$TS] ROGUE DETECTED (load: $LOAD):" >> $LOG

  KILLED=""
  while IFS='|' read -r PID USER CPU CMD; do
    [ -z "$PID" ] && continue
    echo "  KILL PID $PID user=$USER cpu=$CPU% cmd=$CMD" >> $LOG
    kill -9 $PID 2>/dev/null
    KILLED="PID:$PID CPU:${CPU}% CMD:$(basename $CMD)"
  done <<< "$KILL_LIST"

  rm -f /tmp/mysql 2>/dev/null
  touch /tmp/mysql && chmod 000 /tmp/mysql && chattr +i /tmp/mysql 2>/dev/null

  MSG="FRIDAY WATCHDOG: Rogue process killed on FRIDAY server. $KILLED Load:$LOAD $TS"

  curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID/Messages.json" \
    -u "$TWILIO_SID:$TWILIO_TOKEN" \
    --data-urlencode "To=$BRIAN_PHONE" \
    --data-urlencode "From=$TWILIO_FROM" \
    --data-urlencode "Body=$MSG" >> $LOG 2>&1

  echo "" >> $LOG
  echo "[$TS] Killed + SMS sent" >> $LOG
fi
