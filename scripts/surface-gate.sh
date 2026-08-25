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
check 201 "POST /clubs" -X POST "${AO[@]}" "${JSON[@]}" -d '{"name":"Gate Club"}' "$API/clubs"
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

echo "== races: you run the races you are in =="
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
# ADR-0027, 2026-08-12: management is roster-gated. A club admin who is not on THIS race's
# roster has a plain member's powers over it - so the two lines below flipped from 200/201 to
# refusals, and the roster admin (the owner, put on the roster by creating it) is what proves
# the permission still exists at all.
check 404 "PATCH meet-info as admin off-roster" -X PATCH "${AA[@]}" "${JSON[@]}" -d '{"meetDescription":"x"}' "$API/races/$RACE/meet-information"
check 200 "PATCH meet-info as roster admin"     -X PATCH "${AO[@]}" "${JSON[@]}" -d '{"meetDescription":"Leaving at 6am"}' "$API/races/$RACE/meet-information"
check 404 "POST car-group as admin off-roster"  -X POST "${AA[@]}" "$API/races/$RACE/car-groups"
check 201 "POST car-group as roster admin"      -X POST "${AO[@]}" "$API/races/$RACE/car-groups"
GROUP=$(jsonf "['groupId']")
# PRD/09 rule 16: only somebody with real race access can be seated. Attempted BY a manager who
# can, ON a club admin who has no roster row - otherwise the refusal proves the wrong thing.
check 404 "seat somebody with no race access"   -X POST "${AO[@]}" "${JSON[@]}" -d "{\"userId\":\"$(curl -sS "${AA[@]}" "$API/me" | python3 -c 'import json,sys;print(json.load(sys.stdin)["userId"])')\"}" "$API/car-groups/$GROUP/members"

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
# ADR-0028, 2026-08-13: reactions are a 1,914-row catalog, not six hardcoded emoji, so 🦄 is now
# a legitimate reaction and this line used to assert the opposite. The catalog's real edge is skin
# tone - 330 emoji support it and the catalog deliberately excludes every variant - so that is
# what "outside the set" has to mean now.
check 400 "news reaction, skin-tone variant" -X POST "${AM[@]}" "${JSON[@]}" -d '{"emoji":"👏🏽"}' "$API/news/$NEWS/reactions"
check 400 "news reaction that is not emoji"  -X POST "${AM[@]}" "${JSON[@]}" -d '{"emoji":"nope"}' "$API/news/$NEWS/reactions"
check 200 "news reaction, plain in catalog"  -X POST "${AM[@]}" "${JSON[@]}" -d '{"emoji":"👏"}' "$API/news/$NEWS/reactions"
check 200 "news reaction, once in the six"   -X POST "${AM[@]}" "${JSON[@]}" -d '{"emoji":"🔥"}' "$API/news/$NEWS/reactions"

# 2026-08-16: a post grew a headline, a gallery, a place, tags and a cast. See ADR-0038 to 0040.
# The seventh photo is the one worth having over TCP: the composer stops at six, the route stops
# at six, and a constraint stops at six, and only this line proves the middle one is wired.
check 201 "POST news, title only"   -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"Evening Run in Binghamton"}' "$API/clubs/$CLUB/news"
check 400 "POST news, blank title and body" -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"  ","body":"  "}' "$API/clubs/$CLUB/news"
check 400 "POST news, seventh photo" -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"Seven","mediaIds":["11111111-1111-4111-8111-111111111101","11111111-1111-4111-8111-111111111102","11111111-1111-4111-8111-111111111103","11111111-1111-4111-8111-111111111104","11111111-1111-4111-8111-111111111105","11111111-1111-4111-8111-111111111106","11111111-1111-4111-8111-111111111107"]}' "$API/clubs/$CLUB/news"
check 400 "POST news, aspect off the list" -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"Wide","aspect":"3:2"}' "$API/clubs/$CLUB/news"
check 400 "POST news, link with no place"  -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"Where","locationUrl":"https://maps.example.invalid/x"}' "$API/clubs/$CLUB/news"
check 400 "POST news, naming a non-member" -X POST "${AO[@]}" "${JSON[@]}" -d '{"title":"Recap","peopleIds":["11111111-1111-4111-8111-1111111111ff"]}' "$API/clubs/$CLUB/news"
check 200 "GET news search"          "${AM[@]}" "$API/clubs/$CLUB/news?q=Binghamton"
check 200 "GET news tag candidates as owner"  "${AO[@]}" "$API/clubs/$CLUB/news/member-candidates"
# Non-disclosing: a member who cannot post must not learn the roster by exclusion.
check 404 "GET news tag candidates as member" "${AM[@]}" "$API/clubs/$CLUB/news/member-candidates"
# A meetup is named rather than placed since 2026-08-15, and carries no place column at all since
# 2026-08-25 (ADR-0049): the form asks for a link, not a place,
# so the NAME is what a blank is refused for. This gate is what caught the rename reaching every
# test and none of the callers - `npm test` was green while CI was red, because the gate goes over
# TCP against a running server and a test does not.
check 201 "POST meetup" -X POST "${AO[@]}" "${JSON[@]}" -d '{"meetupDate":"2027-05-03","meetupTime":"18:30","title":"Practice","mapUrl":"https://maps.apple.com/?ll=42.0887,-75.9698"}' "$API/clubs/$CLUB/meetups"
check 400 "meetup with no name"       -X POST "${AO[@]}" "${JSON[@]}" -d '{"meetupDate":"2027-05-03","meetupTime":"18:30"}' "$API/clubs/$CLUB/meetups"
check 400 "meetup with a blank name"  -X POST "${AO[@]}" "${JSON[@]}" -d '{"meetupDate":"2027-05-03","meetupTime":"18:30","title":"   "}' "$API/clubs/$CLUB/meetups"
check 400 "meetups without a monday"  "${AO[@]}" "$API/clubs/$CLUB/meetups"
# Only TODAY's meetups are nudgeable, so these are made on today's date rather than a fixed one.
TODAY=$(date -u +%Y-%m-%d)
mk() { curl -sS -X POST "${AO[@]}" "${JSON[@]}" -d "{\"meetupDate\":\"$1\",\"meetupTime\":\"$2\",\"title\":\"$3\"}" "$API/clubs/$CLUB/meetups" | python3 -c 'import json,sys;print(json.load(sys.stdin)["meetupId"])'; }
MEETUP=$(mk "$TODAY" 07:00 Track)
OTHER=$(mk "$TODAY" 19:00 "The Anchor")
PAST=$(mk 2020-05-06 07:00 Gone)
FUTURE=$(mk 2099-05-06 07:00 Later)
check 404 "nudge as member"             -X POST "${AM[@]}" "$API/meetups/$MEETUP/nudge"
check 202 "nudge as admin"              -X POST "${AO[@]}" "$API/meetups/$MEETUP/nudge"
# 409 rather than 404: a cooldown is a conflict, and the body names when it lifts (ADR-0030).
check 409 "nudge the SAME one again"    -X POST "${AO[@]}" "$API/meetups/$MEETUP/nudge"
# The clock is per MEETUP (ADR-0031), so the evening one is untouched by the morning one.
check 202 "nudge a DIFFERENT one"       -X POST "${AO[@]}" "$API/meetups/$OTHER/nudge"
# Today ONLY, in both directions. A past day has nothing left to say and a future one is early.
check 409 "nudge a day that has been"   -X POST "${AO[@]}" "$API/meetups/$PAST/nudge"
check 409 "nudge a day still to come"   -X POST "${AO[@]}" "$API/meetups/$FUTURE/nudge"
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

# Editing a message. Sends go over the socket rather than HTTP, so this gate has no message of
# its own to correct - but every REFUSAL the route owns is reachable without one, and the
# refusals are the half worth gating. The success path is covered by `edits.test.ts`.
echo "== editing a message =="
EDIT="$API/channels/$CHAN/messages"
check 400 "edit with an empty body"   -X POST "${AO[@]}" "${JSON[@]}" -d '{"body":""}' "$EDIT/1/body"
# `.strict()` is what stops this route becoming the omnibus PATCH that v1's column-level
# authority trap needed: a payload carrying `type` alongside `body` is refused out loud rather
# than silently stripped, which is the difference between a member being unable to retro-flip
# their message into an announcement and merely appearing unable to.
check 400 "edit carrying a stray type field" -X POST "${AO[@]}" "${JSON[@]}" \
  -d '{"body":"hi","type":"announcement"}' "$EDIT/1/body"
check 400 "edit with a non-numeric seq" -X POST "${AO[@]}" "${JSON[@]}" -d '{"body":"hi"}' "$EDIT/abc/body"
check 404 "edit a seq that does not exist" -X POST "${AO[@]}" "${JSON[@]}" -d '{"body":"hi"}' "$EDIT/999999/body"
check 404 "edit as an outsider" -X POST "${AX[@]}" "${JSON[@]}" -d '{"body":"hi"}' "$EDIT/1/body"

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

# Reporting a person, and the queue it does NOT reach.
#
# The refusals are the point here, exactly as they are everywhere else in this gate. A club Owner
# holds every authority there is over both parties and still gets nothing from the person queue -
# that is ADR-0034 stated as a request rather than as prose, and it is the one claim a reader of
# the policy module cannot confirm by reading it.
echo "== reporting a person =="
check 201 "report a member you share a club with" -X POST "${AO[@]}" "$API/users/$MEMBER_ID/report"
check 201 "reporting twice is a no-op, and still a success" -X POST "${AO[@]}" "$API/users/$MEMBER_ID/report"
check 404 "report yourself" -X POST "${AM[@]}" "$API/users/$MEMBER_ID/report"
check 404 "report somebody you share no club with" -X POST "${AX[@]}" "$API/users/$MEMBER_ID/report"
check 404 "report a malformed id" -X POST "${AO[@]}" "$API/users/not-a-uuid/report"
check 404 "the Owner cannot read the person queue" "${AO[@]}" "$API/moderation/user-reports"
check 404 "an outsider cannot read the person queue" "${AX[@]}" "$API/moderation/user-reports"
check 404 "the Owner cannot dismiss a person report" -X POST "${AO[@]}" "$API/moderation/user-reports/$MEMBER_ID/dismiss"

check 409 "DELETE /me while owning a club"  -X DELETE "${AO[@]}" "$API/me"
check 200 "DELETE /me as a plain member"    -X DELETE "${AM[@]}" "$API/me"
check 401 "the deleted account's token is dead" "${AM[@]}" "$API/clubs"

echo "== the two routes that take no session at all =="
# Added 2026-08-25 with the apex join page and the Resend bounce webhook. Both are
# unauthenticated on purpose, which is exactly why they belong in a gate that runs over TCP:
# an auth mistake on either one is invisible to a unit test that never binds a port.
#
# No Authorization header on any of these, deliberately. Passing one would prove the route
# works for a signed-in caller and say nothing about the case that matters.
check 404 "an unknown invite token previews as 404, and reveals nothing" "$API/invites/nosuchtoken000000000000/preview"
check 404 "a malformed invite token is 404, never 500" "$API/invites/not-a-token/preview"
check 401 "the mail webhook refuses a body with no signature" -X POST -H 'content-type: application/json' -d '{}' "$API/webhooks/resend"
check 401 "the mail webhook refuses a forged signature" -X POST -H 'content-type: application/json' \
  -H 'svix-id: msg_gate' -H 'svix-timestamp: 1' -H 'svix-signature: v1,Zm9yZ2Vk' -d '{}' "$API/webhooks/resend"

echo "== malformed ids are 404, never 500 =="
for p in "/clubs/not-a-uuid" "/users/not-a-uuid" "/races/not-a-uuid" "/polls/not-a-uuid" "/eboards/not-a-uuid" "/channels/undefined/messages"; do
  check 404 "GET $p" "${AO[@]}" "$API$p"
done

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
