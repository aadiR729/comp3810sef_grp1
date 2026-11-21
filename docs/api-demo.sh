#!/usr/bin/env bash
# =====================================================================
# COMP3810SEF Group 1 — Library REST API live demo (Person 3)
#
# Runs the curl commands from docs/API.md as a guided demo.
#
# Usage:
#     bash docs/api-demo.sh
#     BASE=https://my-server.example.com bash docs/api-demo.sh
#
# Requirements:
#   * the app is running (node server.js) on $BASE
#   * the database is seeded (node seed.js) so the demo books exist
#   * curl is installed (it is on every Ubuntu server)
#
# Person 2's login route (POST /login with username + password) is used to get
# a real session cookie, exactly like the browser does.
# =====================================================================
set -u

BASE="${BASE:-http://localhost:3000}"

LIB_JAR="$(mktemp)"
MEMBER1_JAR="$(mktemp)"
MEMBER2_JAR="$(mktemp)"

cleanup() { rm -f "$LIB_JAR" "$MEMBER1_JAR" "$MEMBER2_JAR"; }
trap cleanup EXIT

# --- output helpers --------------------------------------------------
step() {
    printf '\n\033[1;36m▶ %s\033[0m\n' "$*"
}

expect() {
    printf '\033[1;33m  ↳ expect: %s\033[0m\n' "$*"
}

# Print the status line, the Location header (if any) and the JSON body,
# trimmed so a long catalog does not flood the terminal.
show() {
    printf '%s\n' "$1" | tr -d '\r' | awk '
        NR == 1 { print "  " $0; next }
        /^Location:/ { print "  " $0 }
        /^$/ { body = 1; next }
        body { print "  " substr($0, 1, 180) }
    '
}

first_id() {
    grep -oE '"id":"[a-f0-9]{24}"' | head -n 1 | cut -d'"' -f4
}

login() { # $1 = cookie jar, $2 = username
    curl -s -i -c "$1" -X POST "$BASE/login" \
        --data-urlencode "username=$2" \
        --data-urlencode "password=password123"
}

# --- the demo --------------------------------------------------------

step "0. Is the server up?   GET $BASE/api"
show "$(curl -s -i --max-time 10 "$BASE/api")"

step "1. Not logged in: the API refuses with 401"
show "$(curl -s -i "$BASE/api/books")"
expect '401, { "success": false, "code": "UNAUTHENTICATED" }'

step "2. Log in as the librarian (the cookie jar keeps the session)"
show "$(login "$LIB_JAR" librarian1)"
expect '200 or 302, with a Set-Cookie header'

step "3. Read the catalog:   GET /api/books?limit=3"
show "$(curl -s -i -b "$LIB_JAR" "$BASE/api/books?limit=3")"
expect '200, three books and a pagination block'

step "4. Search like the search bar:   GET /api/books?search=clean"
show "$(curl -s -i -b "$LIB_JAR" "$BASE/api/books?search=clean")"
expect '200 with "Clean Code"'

step "5. Add a book (librarian only):   POST /api/books"
CREATE_RAW="$(curl -s -i -b "$LIB_JAR" -X POST "$BASE/api/books" \
    -H "Content-Type: application/json" \
    -d '{"title":"The Pragmatic Programmer","author":"Andrew Hunt","isbn":"9780201616224","category":"Technology","totalCopies":2}')"
show "$CREATE_RAW"
expect '201 Created, a Location header and 2 available copies'

BOOK_ID="$(printf '%s' "$CREATE_RAW" | first_id)"
printf '  \033[90mBOOK_ID=%s\033[0m\n' "${BOOK_ID:-<none>}"

if [ -z "$BOOK_ID" ]; then
    printf '\n\033[1;31mCould not create the demo book (is the database seeded? is the ISBN already used?).\033[0m\n'
    exit 1
fi

step "6. Edit the book (librarian only):   PUT /api/books/<id>"
show "$(curl -s -i -b "$LIB_JAR" -X PUT "$BASE/api/books/$BOOK_ID" \
    -H "Content-Type: application/json" \
    -d '{"totalCopies":3}')"
expect '200, availableCopies follows the new total'

step "7. Log in as member1"
show "$(login "$MEMBER1_JAR" member1)"

step "8. member1 borrows the book:   POST /api/loans"
BORROW_RAW="$(curl -s -i -b "$MEMBER1_JAR" -X POST "$BASE/api/loans" \
    -H "Content-Type: application/json" \
    -d "{\"bookId\":\"$BOOK_ID\"}")"
show "$BORROW_RAW"
expect '201, dueDate = today + 14 days, status "active"'

LOAN_ID="$(printf '%s' "$BORROW_RAW" | first_id)"
printf '  \033[90mLOAN_ID=%s\033[0m\n' "${LOAN_ID:-<none>}"

step "9. The same member tries the same book again:   409 ALREADY_BORROWED"
show "$(curl -s -i -b "$MEMBER1_JAR" -X POST "$BASE/api/loans" \
    -H "Content-Type: application/json" \
    -d "{\"bookId\":\"$BOOK_ID\"}")"
expect '409, { "code": "ALREADY_BORROWED" }'

step '10. Out of stock: "To Kill a Mockingbird" has only 1 copy'
MOCKINGBIRD_ID="$(curl -s -b "$LIB_JAR" "$BASE/api/books?search=mockingbird" | first_id)"
printf '  \033[90mMOCKINGBIRD_ID=%s\033[0m\n' "${MOCKINGBIRD_ID:-<none>}"

if [ -n "$MOCKINGBIRD_ID" ]; then
    printf '  member1 takes the only copy:\n'
    MOCK_RAW="$(curl -s -i -b "$MEMBER1_JAR" -X POST "$BASE/api/loans" \
        -H "Content-Type: application/json" \
        -d "{\"bookId\":\"$MOCKINGBIRD_ID\"}")"
    show "$MOCK_RAW"
    MOCK_LOAN_ID="$(printf '%s' "$MOCK_RAW" | first_id)"
    expect '201, and availableCopies is now 0'

    printf '  member2 now tries the same book:\n'
    show "$(login "$MEMBER2_JAR" member2 | head -n 1)"
    show "$(curl -s -i -b "$MEMBER2_JAR" -X POST "$BASE/api/loans" \
        -H "Content-Type: application/json" \
        -d "{\"bookId\":\"$MOCKINGBIRD_ID\"}")"
    expect '409, { "code": "OUT_OF_STOCK" } — the friendly "Out of stock!" message'

    if [ -n "$MOCK_LOAN_ID" ]; then
        printf '  cleanup — member1 gives it back:\n'
        show "$(curl -s -i -b "$MEMBER1_JAR" -X PUT "$BASE/api/loans/$MOCK_LOAN_ID/return")"
        expect '200, availableCopies back to 1'
    fi
else
    printf '  \033[1;33m(skipped: run node seed.js first)\033[0m\n'
fi

step "11. member1 returns the demo book:   PUT /api/loans/<id>/return"
show "$(curl -s -i -b "$MEMBER1_JAR" -X PUT "$BASE/api/loans/$LOAN_ID/return")"
expect '200, status "returned" and the stock goes back up'

step "12. Returning twice is refused:   400 ALREADY_RETURNED"
show "$(curl -s -i -b "$MEMBER1_JAR" -X PUT "$BASE/api/loans/$LOAN_ID/return")"
expect '400, { "code": "ALREADY_RETURNED" }'

step "13. The librarian sees every loan:   GET /api/loans?status=active"
show "$(curl -s -i -b "$LIB_JAR" "$BASE/api/loans?status=active")"
expect '200 with the loans of every member'

step "14. Delete the demo book:   DELETE /api/books/<id>"
show "$(curl -s -i -b "$LIB_JAR" -X DELETE "$BASE/api/books/$BOOK_ID")"
expect '200, because no copy of it is on loan any more'

printf '\n\033[1;32mDemo finished.\033[0m  Notes:\n'
printf '  * Every 409/400 above is a normal business answer, not a crash.\n'
printf '  * Responses share one shape: { success, data } or { success, error, code }.\n'
printf '  * Full reference and copy-paste commands: docs/API.md\n\n'
