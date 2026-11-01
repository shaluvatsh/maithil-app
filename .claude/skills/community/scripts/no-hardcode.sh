#!/usr/bin/env bash
#
# The Law 2 gate: no unowned literal in community code.
#
# It derives the city, panjika and locale lists from packages/region at runtime rather
# than carrying its own copy — a hardcode detector with hardcoded values would be a
# joke at its own expense, and this way adding a city extends the check for free.
#
# Usage:
#   .claude/skills/community/scripts/no-hardcode.sh            # scan community sources
#   .claude/skills/community/scripts/no-hardcode.sh path ...   # scan specific files
#
# Suppress a legitimate case with a trailing comment on the same line:
#   const slug = 'kolkata';  // no-hardcode: historical data fix, see ADR 0003
#
# Exit 0 = clean. Exit 1 = findings.

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo"; exit 1; }
cd "$ROOT" || exit 1

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[ -t 1 ] || { RED=""; YEL=""; GRN=""; DIM=""; OFF=""; }

# --- the source of truth, read at runtime -----------------------------------
REGIONS_GLOB="packages/region/src/regions"
TYPES="packages/region/src/types.ts"

union_members() { # $1 = type name, reads the union out of types.ts
  sed -n "/export type $1 *=/,/;/p" "$TYPES" 2>/dev/null \
    | grep -Eo "'[a-z_]+'" | tr -d "'" | sort -u
}

CITY_SLUGS=$(grep -Eho "slug: *'[a-z0-9-]+'" "$REGIONS_GLOB"/*.ts 2>/dev/null \
             | sed -E "s/.*'([a-z0-9-]+)'.*/\1/" | sort -u)
PANJIKAS=$(union_members PanjikaId)
LOCALES=$(union_members Locale)

join_alt() { tr '\n' '|' | sed 's/|$//'; }
CITY_RE=$(printf '%s\n' "$CITY_SLUGS"  | join_alt)
PANJ_RE=$(printf '%s\n' "$PANJIKAS"    | join_alt)
LOC_RE=$(printf  '%s\n' "$LOCALES"     | join_alt)

[ -n "$CITY_RE" ] || { echo "${RED}cannot read city slugs from $REGIONS_GLOB${OFF}"; exit 1; }

# --- what to scan -----------------------------------------------------------
# Owners and historical records are excluded: packages/region owns these values,
# migrations record data fixes that already happened, seeds and fixtures build a
# specific city on purpose. See references/value-ownership.md.
# `modules/assistant/knowledge.ts` is the WhatsApp assistant's retrieval corpus, not
# the community knowledge library. Different thing, same word; it has its own owner.
EXCLUDE='(^packages/region/|/migrations/|/seed/|/modules/assistant/|__tests__|\.test\.|\.spec\.|/test/)'
# Path-scoped, which will always miss a call site: `app/pooja/[slug]/page.tsx`
# renders ritual guides and carries none of these words, so a hardcoded page size
# there went unseen until it was found by hand. `pooja` is named for that reason —
# and the lesson is that this list needs extending whenever a surface outside it
# starts consuming community data.
SCOPE='(community|event|knowledge|feed|moderation|forum|learn|post|pooja)'

if [ "$#" -gt 0 ]; then
  FILES=$(printf '%s\n' "$@")
else
  # --others --exclude-standard, not a bare ls-files: a feature's files are
  # UNTRACKED while it is being written, which is exactly when this gate is worth
  # running. A tracked-only scan reported "no community sources yet" against a
  # finished module sitting in the working tree.
  FILES=$(git ls-files --cached --others --exclude-standard '*.ts' '*.tsx' '*.sql' 2>/dev/null \
          | sort -u | grep -Ei "$SCOPE" | grep -Ev "$EXCLUDE")
fi

if [ -z "$FILES" ]; then
  echo "${DIM}no community sources yet — the gate activates with the first file"
  echo "matching /$SCOPE/ outside region, migrations, seeds and tests.${OFF}"
  exit 0
fi

FILE_COUNT=$(printf '%s\n' "$FILES" | grep -c . )
FAIL=0

report() { # $1 = severity, $2 = rule, $3 = fix, $4 = egrep pattern
  local sev="$1" rule="$2" fix="$3" pat="$4" hits
  # Comment lines are dropped before judging. A rule that fails on the comment
  # explaining the rule teaches people to delete the explanation, which is the
  # opposite of what this is for -- and every reference in this skill describes the
  # banned pattern in prose next to the code that avoids it.
  hits=$(printf '%s\n' "$FILES" | xargs grep -nHE "$pat" 2>/dev/null \
         | grep -v 'no-hardcode:' \
         | grep -Ev '^[^:]+:[0-9]+: *(\*|//|--|/\*)' )
  [ -z "$hits" ] && return 0
  if [ "$sev" = "fail" ]; then
    printf '%s\n' "${RED}✗ $rule${OFF}"; FAIL=1
  else
    printf '%s\n' "${YEL}! $rule${OFF}"
  fi
  printf '%s\n' "  ${DIM}use instead: $fix${OFF}"
  printf '%s\n' "$hits" | sed 's/^/    /'
  echo
}

echo "${DIM}scanning $FILE_COUNT file(s) · ${CITY_RE//|/, }${OFF}"
echo

# --- Tier 1: values owned by packages/region --------------------------------
report fail "city slug literal" \
  "config.launchCitySlug, or the city on the request" \
  "['\"](${CITY_RE})['\"]"

report fail "timezone or UTC offset literal" \
  "region.timezone / region.utcOffsetMinutes — Nepal is +05:45" \
  "(Asia/[A-Za-z_]+|utcOffset[A-Za-z]* *[:=] *[0-9]+|[^a-zA-Z_](330|5\.5)[^0-9])"

report fail "locale literal used as a default or comparison" \
  "region.locales[0], or the row's own locale column" \
  "([=!]==? *|\?\? *|default\(|locale *[:=] *)['\"](${LOC_RE})['\"]"

report fail "panjika id literal" \
  "region.defaultPanjika, or the row's snapshotted school" \
  "['\"](${PANJ_RE})['\"]"

report fail "currency or number formatting literal" \
  "the formatters in packages/region/src/format.ts" \
  "(₹|['\"]en-IN['\"]|['\"]INR['\"]|toLocaleString\(['\"]|Intl\.NumberFormat\(['\"])"

report fail "hardcoded slot count or slot index array" \
  "region.slots and region.slots.length — the south uses five" \
  "(slot[A-Za-z]*(Count|Len|Total) *[:=] *[0-9]|\[ *0 *, *1 *, *2 *, *3 *\])"

# --- Tier 2/3: values owned by contracts, config or the database ------------
report fail "process.env read with an inline fallback" \
  "config.<key>, with the default in the zod schema in common/config.ts" \
  "process\.env\.[A-Z_]+ *(\?\?|\|\|) *['\"]"

report fail "tunable literal with no owner (page size, radius, ttl, cap, sla)" \
  "packages/contracts if both apps need it, else loadConfig() with a .default()" \
  "(pageSize|perPage|limit|radiusKm|ttl|maxSeats|capacity|slaHours|overbook|holdSeconds|batchSize) *[:=] *[0-9]+"

report fail "moderation lexicon in source" \
  "the moderation_terms table — a slur list in code means a deploy during an incident" \
  "(banned|prohibited|blocked|blocklist|denylist)[A-Za-z]*(Words|Terms|List) *[:=] *\["

# --- scale smells: warnings, not failures -----------------------------------
report warn "OFFSET pagination in a feed query" \
  "keyset pagination on (sort_key, id) — OFFSET is O(offset) and degrades as you grow" \
  "(offset\(|OFFSET +[0-9\$])"

report warn "COUNT(*) where a maintained counter belongs" \
  "a counter column maintained by trigger; counting per row in a list is N+1" \
  "(count\(\*\)|COUNT\(\*\))"

report warn "background job with no advisory lock" \
  "pg_advisory_lock — an unlocked job corrupts itself the day you add a second instance" \
  "(setInterval|@Cron|Cron\()"

# --- verdict ----------------------------------------------------------------
if [ "$FAIL" -eq 0 ]; then
  echo "${GRN}✓ no unowned literals${OFF}"
  echo "${DIM}warnings above, if any, are judgement calls — justify them in the PR.${OFF}"
else
  echo "${RED}gate failed.${OFF} Each finding has an owner in"
  echo "${DIM}.claude/skills/community/references/value-ownership.md — move the value there,"
  echo "or suppress with a trailing '// no-hardcode: <reason>' if it is one of the three"
  echo "legitimate cases listed in that file.${OFF}"
fi
exit "$FAIL"
