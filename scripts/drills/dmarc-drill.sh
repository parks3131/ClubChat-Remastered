#!/usr/bin/env bash
#
# The DMARC tightening drill: read what the sending domain publishes today, decide whether it is
# safe to tighten, and print the exact record edit.
#
#   ./scripts/drills/dmarc-drill.sh
#   ./scripts/drills/dmarc-drill.sh --stage quarantine
#   ./scripts/drills/dmarc-drill.sh --domain clubchatapp.com --selector resend --stage reject
#
# **This script never changes DNS, and it has no flag that would.** There is no --execute here,
# unlike the other two drills, and that is deliberate rather than unfinished. The record lives in
# Cloudflare and the change is one field in one TXT record; a script holding a Cloudflare token
# able to rewrite the apex zone is a far larger standing risk than the thirty seconds it would
# save, and SPEC/decisions and the deployment doc both record the Cloudflare API token as a
# credential to be revoked rather than kept. So this reads, judges, and prints the edit for a
# human to make.
#
# ## Why p=none is the starting point and not the finish
#
# SPF proves the sending SERVER is authorized for the envelope domain. DKIM proves the message was
# signed and unaltered. Neither looks at the `From:` header, which is the only address a member
# ever sees, so both can pass for an attacker's own domain while ClubChat's name is displayed.
# DMARC is the record that requires the domain which passed SPF or DKIM to ALIGN with the visible
# `From:`, and states what a receiver should do when it does not.
#
# `p=none` states "do nothing about it, but tell me". It is the correct first move and it is not
# protection: a spoofed password-reset mail is delivered exactly as before.
#
# ## Why tightening early is the failure mode, not the safe choice
#
# **A policy published while authentication is failing is an instruction to receivers to reject
# your own mail.** SPEC/templates/sending-domain-checklist.md opens with the case that makes this
# concrete: on 2026-08-07 `parkstechusa.com` read *verified* in the provider dashboard while
# publishing no SPF and no DKIM at all, for a month, and mail kept being accepted the whole time.
# Delivery is not authentication. Had a `p=reject` been published in that window, every
# password-reset mail the product sent would have gone to spam or been refused outright, and the
# provider dashboard would still have said `delivered`, because a receiving server accepting the
# bytes is all that word means.
#
# So this script gates the tightening on evidence, and it is honest about the one piece of
# evidence DNS cannot give: what a real receiver decided about a real message. That step is
# printed at the end and the drill is not complete without it.
set -euo pipefail

domain=clubchatapp.com
selector=resend
bounce_host=send
stage=''

usage() {
  cat <<'USAGE'
DMARC drill: read the sending domain's authentication records and print the next record edit.

  ./scripts/drills/dmarc-drill.sh [--domain <domain>] [--selector <dkim-selector>]
                                  [--bounce <label>] [--stage none|quarantine|reject]

  --domain    Sending domain. Default clubchatapp.com.
  --selector  DKIM selector. Default resend, which is what Resend publishes.
  --bounce    Label carrying SPF and the bounce MX. Default send, which is Resend's.
  --stage     Which policy to print the edit for. Default: the next one after the current.
  --help      This.

READ ONLY. This script changes nothing and has no flag that would. It runs dig and curl
against public DNS and prints an edit for a human to make in Cloudflare.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain=${2:-}; shift 2 ;;
    --selector) selector=${2:-}; shift 2 ;;
    --bounce) bounce_host=${2:-}; shift 2 ;;
    --stage) stage=${2:-}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; printf '\nREFUSED: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "${stage:-}" in
  ''|none|quarantine|reject) ;;
  *) printf '\nREFUSED: --stage must be none, quarantine or reject.\n' >&2; exit 2 ;;
esac

command -v dig >/dev/null 2>&1 || { printf '\nREFUSED: dig is not on PATH.\n' >&2; exit 2; }

pass=0
fail=0
note() { printf 'ok    %-22s %s\n' "$1" "$2"; pass=$((pass + 1)); }
bad()  { printf 'FAIL  %-22s %s\n' "$1" "$2"; fail=$((fail + 1)); }

# `dig +short TXT` returns each string quoted, and splits long records into several quoted chunks.
# Stripping the quotes and joining is what turns that back into the value a receiver sees.
txt() {
  dig +short TXT "$1" "${2:+@$2}" 2>/dev/null | tr -d '"' | tr -d '\n'
}

printf 'ClubChat DMARC drill\n'
printf '====================\n\n'
printf 'domain         %s\n' "$domain"
printf 'DKIM selector  %s._domainkey.%s\n' "$selector" "$domain"
printf 'bounce host    %s.%s\n' "$bounce_host" "$domain"
printf 'mode           READ ONLY. Nothing here changes DNS.\n\n'

# ---------------------------------------------------------------------------
# Where the records actually live
# ---------------------------------------------------------------------------

nameservers=$(dig +short NS "$domain" | sort || true)
if [[ -z $nameservers ]]; then
  bad 'nameservers' "no NS records for $domain, so nothing below means anything"
  exit 1
fi
authoritative=$(head -n 1 <<<"$nameservers")
note 'nameservers' "$(tr '\n' ' ' <<<"$nameservers")"
printf '      %-22s asking %s directly, and 8.8.8.8 for propagation\n' '' "$authoritative"

# ---------------------------------------------------------------------------
# SPF and DKIM. Both must be right BEFORE a policy is tightened.
# ---------------------------------------------------------------------------

spf=$(txt "$bounce_host.$domain" "$authoritative")
if [[ $spf == v=spf1* ]]; then
  note 'spf' "$spf"
else
  bad 'spf' "no v=spf1 record at $bounce_host.$domain (got: ${spf:-nothing})"
fi

bounce_mx=$(dig +short MX "$bounce_host.$domain" "@$authoritative" 2>/dev/null | tr '\n' ' ' || true)
if [[ -n $bounce_mx ]]; then
  note 'bounce mx' "$bounce_mx"
else
  bad 'bounce mx' "no MX at $bounce_host.$domain, so bounces have nowhere to go"
fi

dkim=$(txt "$selector._domainkey.$domain" "$authoritative")
if [[ $dkim == *p=* ]]; then
  note 'dkim' "public key present at $selector._domainkey.$domain (${#dkim} chars)"
else
  bad 'dkim' "no key at $selector._domainkey.$domain (got: ${dkim:-nothing})"
fi

# ---------------------------------------------------------------------------
# The DMARC record itself
# ---------------------------------------------------------------------------

dmarc=$(txt "_dmarc.$domain" "$authoritative")
dmarc_public=$(txt "_dmarc.$domain" 8.8.8.8)

if [[ $dmarc != v=DMARC1* ]]; then
  bad 'dmarc' "no v=DMARC1 record at _dmarc.$domain (got: ${dmarc:-nothing})"
  current_policy=absent
else
  note 'dmarc' "$dmarc"
  current_policy=$(sed -n 's/.*[; ]*p=\([a-z]*\).*/\1/p' <<<"$dmarc")
  current_policy=${current_policy:-none}
fi

if [[ $dmarc_public == "$dmarc" ]]; then
  note 'propagation' "8.8.8.8 returns the same record"
else
  bad 'propagation' "8.8.8.8 returns \"${dmarc_public:-nothing}\", the origin returns \"${dmarc:-nothing}\""
fi

rua=$(sed -n 's/.*rua=\([^;]*\).*/\1/p' <<<"$dmarc" | tr -d ' ')
if [[ -n $rua ]]; then
  note 'aggregate reports' "$rua"
  rua_domain=${rua##*@}
  if [[ $rua_domain != "$domain" && $rua_domain != *".$domain" ]]; then
    bad 'rua domain' "$rua_domain is not $domain, so reports are DROPPED unless $rua_domain publishes an authorization record for it"
  fi
else
  bad 'aggregate reports' "no rua= address, so nothing is being reported and there is no evidence to tighten on"
fi

# A rua address that cannot receive mail is worse than no rua at all: the record looks complete,
# reports are generated by every large receiver, and every one of them is thrown away. Checked
# here rather than assumed, because the mailbox and the DNS record are configured in different
# panels by different people.
rua_target=${rua:+${rua##*@}}
rua_target=${rua_target:-$domain}
rua_mx=$(dig +short MX "$rua_target" 2>/dev/null | tr '\n' ' ' || true)
if [[ -n $rua_mx ]]; then
  note 'rua mailbox' "$rua_target has MX: $rua_mx"
  printf '      %-22s a forwarding host still needs a RULE for the exact address, or reports bounce\n' ''
else
  bad 'rua mailbox' "$rua_target publishes no MX, so a rua address there would receive nothing"
fi

soa_minimum=$(dig +short SOA "$domain" | awk '{print $NF}')
note 'negative cache' "${soa_minimum:-unknown}s - a receiver that looked up a record before you published it keeps answering from that cached nothing for this long"

printf '\ncurrent policy: %s\n' "$current_policy"

# ---------------------------------------------------------------------------
# The verdict, and the edit
# ---------------------------------------------------------------------------

if [[ -z $stage ]]; then
  case "$current_policy" in
    absent) stage=none ;;
    # p=none with nowhere to send reports is not "ready for quarantine", it is the first step
    # not yet finished: there is no evidence, so the next edit adds the reporting address and
    # leaves the policy exactly where it is.
    none) [[ -n $rua ]] && stage=quarantine || stage=none ;;
    quarantine) stage=reject ;;
    *) stage=reject ;;
  esac
fi

after="v=DMARC1; p=$stage; rua=mailto:dmarc@$domain; fo=1"

printf '\nthe record edit\n---------------\n'
printf 'Cloudflare DNS for %s, the TXT record named _dmarc\n\n' "$domain"
printf '  type    TXT\n'
printf '  name    _dmarc            (Cloudflare appends %s; do not type the full name)\n' "$domain"
printf '  ttl     Auto\n'
printf '  proxy   DNS only. A TXT record cannot be proxied, and _dmarc must never be.\n\n'
printf '  before  %s\n' "${dmarc:-<no record>}"
printf '  after   %s\n\n' "$after"

if [[ $stage != none && $fail -gt 0 ]]; then
  printf 'DO NOT MAKE THAT EDIT YET. %s check(s) above failed.\n' "$fail"
  printf 'Tightening the policy while authentication is failing is an instruction to receivers\n'
  printf 'to reject your own mail, and password reset is the only mail this product sends that\n'
  printf 'a member cannot work around.\n'
  exit 1
fi

if [[ $stage != none ]]; then
  cat <<EVIDENCE
Before making that edit, confirm authentication is PASSING at a receiver. DNS cannot
tell you this and neither can the provider dashboard - "delivered" only means a receiving
server accepted the bytes.

  1. Trigger a real password reset to a Gmail address from the live app.
  2. Open the message, the per-message three-dot menu, "Show original".
  3. Read all three lines at the top:
       SPF:   PASS  with domain $bounce_host.$domain
       DKIM:  PASS  with domain $domain   <- the d= MUST be $domain, not the provider's
       DMARC: PASS
     A DKIM d= that is not $domain means alignment is being carried by SPF alone, and
     anything that changes the envelope path later will break it silently.
  4. Read at least two weeks of aggregate reports at ${rua:-<no rua address yet>} and look
     for legitimate senders a strict policy would break. This domain publishes an apex SPF
     for registrar mail forwarding that does NOT include the mail provider, so mail sent
     with an apex envelope is exactly the kind of thing those reports exist to surface.

Then make the edit, and re-check with:
  dig +short TXT _dmarc.$domain @$authoritative
  dig +short TXT _dmarc.$domain @8.8.8.8
and send one more real message, at least ${soa_minimum:-1800}s after the edit, because a
receiver caches the ABSENCE of a record as well as its presence.
EVIDENCE
fi

printf '\n%s check(s) passed, %s failed. Nothing was changed.\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
