#!/usr/bin/env bash
#
# The Phase 3.75a exit gate: every route called against a RUNNING server, in both directions.
#
# Why this is a script rather than a test. Phase 2's gate was "the permission-matrix test suite
# covers every cell", which a domain layer satisfies with no surface at all - and did, for two
# phases. So this phase's gate is deliberately something `npm test` cannot satisfy: it goes over
# TCP, through the real HTTP stack, against the real Postgres, exactly as a client will.
#
#   npm run gate:surface
#   API=http://127.0.0.1:3100 npm run gate:surface
#
# The refusals matter as much as the successes: a member attempting a pin, a club admin with no
# roster row reaching for race chat, a race poll requested by direct URL. A FAIL line on one of
# those reads "this refusal did not happen".
#
# WATCH OUT for the failure this script itself hit first. `npm run dev:api` exits with EADDRINUSE
# when a server is already listening, and the gate then happily tests whatever OLD process owns
# the port - 46 checks "failed" that way before anything was wrong with the code. Point API at a
# port you just started, or grep the server log for EADDRINUSE before believing a result.
set -uo pipefail
API=${API:-http://127.0.0.1:3000}
pass=0; fail=0

# $1 expected status, $2 label, rest: curl args
check() {
  local want="$1" label="$2"; shift 2
  local got
  got=$(curl -sS -o /tmp/gate_body -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then
    pass=$((pass+1)); printf 'ok   %-4s %s\n' "$got" "$label"
  else
    fail=$((fail+1)); printf 'FAIL want=%s got=%s %s\n     body: %s\n' "$want" "$got" "$label" "$(head -c 200 /tmp/gate_body)"
  fi
}
body() { cat /tmp/gate_body; }
jsonf() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)" < /tmp/gate_body; }

signup() { # name -> token
  local email="$1-$(date +%s%N)@gate.invalid"
  curl -sS -X POST "$API/api/auth/sign-up/email" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"email\":\"$email\",\"password\":\"correct-horse-battery-staple\"}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('token',''))"
}

echo "== health =="
check 200 "GET /health" "$API/health"

echo "== sessions =="
OWNER=$(signup owner); MEMBER=$(signup member); ADMIN=$(signup admin); OUTSIDER=$(signup outsider)
[ -n "$OWNER" ] || { echo "FATAL: no owner token"; exit 1; }
AO=(-H "authorization: Bearer $OWNER"); AM=(-H "authorization: Bearer $MEMBER")
AA=(-H "authorization: Bearer $ADMIN"); AX=(-H "authorization: Bearer $OUTSIDER")
JSON=(-H 'content-type: application/json')

check 401 "GET /clubs with no session" "$API/clubs"
check 200 "GET /clubs with a session" "${AO[@]}" "$API/clubs"

echo "== club, roster, search, rotation =="
check 201 "POST /clubs" -X POST "${AO[@]}" "${JSON[@]}" -d '{"name":"Gate Club","sport":"running"}' "$API/clubs"
CLUB=$(jsonf "['clubId']"); TOKEN=$(jsonf "['inviteToken']"); CHAN=$(jsonf "['mainChannelId']"); EB=$(jsonf "['eboardId']")

check 200 "POST /invites/:token/redeem as member"  -X POST "${AM[@]}" "$API/invites/$TOKEN/redeem"
check 200 "POST /invites/:token/redeem as admin"   -X POST "${AA[@]}" "$API/invites/$TOKEN/redeem"
check 200 "PATCH role -> admin"  -X PATCH "${AO[@]}" "${JSON[@]}" -d '{"role":"admin"}' "$API/clubs/$CLUB/members/$(curl -sS "${AA[@]}" "$API/me" | python3 -c 'import json,sys;print(json.load(sys.stdin)["userId"])')/role"

check 200 "GET /clubs/:id as owner"          "${AO[@]}" "$API/clubs/$CLUB"
check 404 "GET /clubs/:id as outsider"       "${AX[@]}" "$API/clubs/$CLUB"
check 200 "GET /clubs/:id/members as member" "${AM[@]}" "$API/clubs/$CLUB/members"
check 404 "GET /clubs/:id/members outsider"  "${AX[@]}" "$API/clubs/$CLUB/members"
check 200 "GET /clubs/search"                "${AX[@]}" "$API/clubs/search?q=Gate"
check 404 "POST rotate as member"            -X POST "${AM[@]}" "$API/clubs/$CLUB/invite-token/rotate"
check 200 "POST rotate as owner"             -X POST "${AO[@]}" "$API/clubs/$CLUB/invite-token/rotate"
check 404 "old invite link is dead"          -X POST "${AX[@]}" "$API/invites/$TOKEN/redeem"

echo "== races: authority is not access =="
check 404 "POST race as member"  -X POST "${AM[@]}" "${JSON[@]}" -d '{"name":"R","raceDate":"2027-01-01"}' "$API/clubs/$CLUB/races"
check 201 "POST race as owner"   -X POST "${AO[@]}" "${JSON[@]}" -d '{"name":"Gate Race","raceDate":"2027-01-01"}' "$API/clubs/$CLUB/races"
RACE=$(jsonf "['raceId']"); RCHAN=$(jsonf "['channelId']")
check 200 "GET /races/:id as member (preview)" "${AM[@]}" "$API/races/$RACE"
check 404 "GET /races/:id as outsider"         "${AX[@]}" "$API/races/$RACE"
check 200 "GET roster as admin off-roster"     "${AA[@]}" "$API/races/$RACE/members"
check 404 "GET car-groups as admin off-roster" "${AA[@]}" "$API/races/$RACE/car-groups"
check 404 "GET race chat as admin off-roster"  "${AA[@]}" "$API/channels/$RCHAN/messages"
check 200 "GET race chat as roster member"     "${AO[@]}" "$API/channels/$RCHAN/messages"
check 404 "PATCH meet-info as member"          -X PATCH "${AM[@]}" "${JSON[@]}" -d '{"meetDescription":"x"}' "$API/races/$RACE/meet-information"
check 200 "PATCH meet-info as manager"         -X PATCH "${AA[@]}" "${JSON[@]}" -d '{"meetDescription":"Leaving at 6am"}' "$API/races/$RACE/meet-information"
check 201 "POST car-group as manager"          -X POST "${AA[@]}" "$API/races/$RACE/car-groups"
GROUP=$(jsonf "['groupId']")
check 404 "seat the off-roster manager"        -X POST "${AA[@]}" "${JSON[@]}" -d "{\"userId\":\"$(curl -sS "${AA[@]}" "$API/me" | python3 -c 'import json,sys;print(json.load(sys.stdin)["userId"])')\"}" "$API/car-groups/$GROUP/members"

echo "== polls: the race scope by direct URL =="
check 201 "POST race poll as roster admin" -X POST "${AO[@]}" "${JSON[@]}" -d '{"question":"Day?","options":["Sat","Sun"]}' "$API/races/$RACE/polls"
POLL=$(jsonf "['pollId']")
check 404 "GET race poll as admin off-roster" "${AA[@]}" "$API/polls/$POLL"
check 404 "GET race poll as plain member"     "${AM[@]}" "$API/polls/$POLL"
check 200 "GET race poll as roster member"    "${AO[@]}" "$API/polls/$POLL"
check 400 "POST poll with 1 option"           -X POST "${AO[@]}" "${JSON[@]}" -d '{"question":"q","options":["only"]}' "$API/clubs/$CLUB/polls"
check 201 "POST club poll"                    -X POST "${AO[@]}" "${JSON[@]}" -d '{"question":"Q","options":["a","b"]}' "$API/clubs/$CLUB/polls"
CPOLL=$(jsonf "['pollId']")
check 200 "GET club poll" "${AO[@]}" "$API/polls/$CPOLL"
OPT=$(jsonf "['poll']['options'][0]['id']")
check 200 "vote"          -X POST "${AM[@]}" "$API/poll-options/$OPT/vote"
check 403 "close as non-creator" -X POST "${AA[@]}" "${JSON[@]}" -d '{"closed":true}' "$API/polls/$CPOLL/closed"
check 200 "close as creator"     -X POST "${AO[@]}" "${JSON[@]}" -d '{"closed":true}' "$API/polls/$CPOLL/closed"

echo "== eboard =="
check 200 "GET /eboards/:id as owner"     "${AO[@]}" "$API/eboards/$EB"
check 404 "GET /eboards/:id as member"    "${AM[@]}" "$API/eboards/$EB"
check 201 "POST meeting as member of space" -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"Sync","startsAt":"2027-03-01T18:00:00.000Z"}' "$API/eboards/$EB/meetings"
MEET=$(jsonf "['meetingId']")
check 200 "GET meeting as creator"  "${AO[@]}" "$API/meetings/$MEET"
check 404 "GET meeting as member"   "${AM[@]}" "$API/meetings/$MEET"
check 200 "GET eboard meetings"     "${AO[@]}" "$API/eboards/$EB/meetings?when=upcoming"

echo "== content and calendar =="
check 404 "POST event as member" -X POST "${AM[@]}" "${JSON[@]}" -d '{"type":"practice","title":"T","startsAt":"2027-04-01T17:00:00.000Z"}' "$API/clubs/$CLUB/events"
check 201 "POST event as owner"  -X POST "${AO[@]}" "${JSON[@]}" -d '{"type":"practice","title":"Track","startsAt":"2027-04-01T17:00:00.000Z"}' "$API/clubs/$CLUB/events"
check 400 "POST empty news"      -X POST "${AO[@]}" "${JSON[@]}" -d '{}' "$API/clubs/$CLUB/news"
check 201 "POST news"            -X POST "${AO[@]}" "${JSON[@]}" -d '{"body":"We won."}' "$API/clubs/$CLUB/news"
NEWS=$(jsonf "['postId']")
check 400 "news reaction outside the set" -X POST "${AM[@]}" "${JSON[@]}" -d '{"emoji":"🦄"}' "$API/news/$NEWS/reactions"
check 200 "news reaction in the set"      -X POST "${AM[@]}" "${JSON[@]}" -d '{"emoji":"🔥"}' "$API/news/$NEWS/reactions"
check 201 "POST meetup" -X POST "${AO[@]}" "${JSON[@]}" -d '{"meetupDate":"2027-05-03","meetupTime":"18:30","location":"Memorial Park gate"}' "$API/clubs/$CLUB/meetups"
check 400 "meetup with no place"      -X POST "${AO[@]}" "${JSON[@]}" -d '{"meetupDate":"2027-05-03","meetupTime":"18:30"}' "$API/clubs/$CLUB/meetups"
check 400 "meetups without a monday"  "${AO[@]}" "$API/clubs/$CLUB/meetups"
check 200 "meetups week"              "${AO[@]}" "$API/clubs/$CLUB/meetups?monday=2027-05-03"
check 200 "calendar merged"           "${AO[@]}" "$API/calendar"
check 200 "calendar club upcoming"    "${AO[@]}" "$API/calendar?club=$CLUB&when=upcoming"
check 200 "calendar markers"          "${AO[@]}" "$API/calendar/markers?club=$CLUB&year=2027&month=4"
check 400 "markers without a month"   "${AO[@]}" "$API/calendar/markers?year=2027"

echo "== highlights, jump-to-message =="
check 200 "GET pinned"        "${AO[@]}" "$API/channels/$CHAN/pinned"
check 200 "GET announcements" "${AO[@]}" "$API/channels/$CHAN/announcements"
check 400 "around without a seq" "${AO[@]}" "$API/channels/$CHAN/messages/around"
check 404 "pinned as outsider" "${AX[@]}" "$API/channels/$CHAN/pinned"

echo "== profile and deletion =="
check 200 "PATCH own profile" -X PATCH "${AM[@]}" "${JSON[@]}" -d '{"name":"Gate Member","dob":"1999-04-01"}' "$API/me/profile"
check 400 "PATCH dob as timestamp" -X PATCH "${AM[@]}" "${JSON[@]}" -d '{"dob":"1999-04-01T00:00:00Z"}' "$API/me/profile"
MEMBER_ID=$(curl -sS "${AM[@]}" "$API/me" | python3 -c 'import json,sys;print(json.load(sys.stdin)["userId"])')
check 200 "GET another profile" "${AO[@]}" "$API/users/$MEMBER_ID"
python3 - <<'PY'
import json
d=json.load(open('/tmp/gate_body'))
print("ok   dob withheld from another member" if 'dob' not in d['profile'] else "FAIL dob leaked to another member")
PY
check 404 "PATCH /users/:id does not exist" -X PATCH "${AO[@]}" "${JSON[@]}" -d '{"name":"Hijack"}' "$API/users/$MEMBER_ID"
check 409 "DELETE /me while owning a club"  -X DELETE "${AO[@]}" "$API/me"
check 200 "DELETE /me as a plain member"    -X DELETE "${AM[@]}" "$API/me"
check 401 "the deleted account's token is dead" "${AM[@]}" "$API/clubs"

echo "== malformed ids are 404, never 500 =="
for p in "/clubs/not-a-uuid" "/users/not-a-uuid" "/races/not-a-uuid" "/polls/not-a-uuid" "/eboards/not-a-uuid" "/channels/undefined/messages"; do
  check 404 "GET $p" "${AO[@]}" "$API$p"
done

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
