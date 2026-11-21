# Library REST API — Person 3 (Core Logic & REST API)

This document covers the Person 3 deliverables:

1. the **borrow / return business logic** (stock checks, due dates),
2. the **RESTful API** at `/api/books` and `/api/loans` (`GET`, `POST`, `PUT`, `DELETE`),
3. the **curl commands** used for the live demo in the presentation.

---

## 1. Where the code lives

| File | What it does |
| --- | --- |
| `services/bookService.js` | Catalog rules: list/search, read, create, edit (incl. stock maths), delete. |
| `services/loanService.js` | **Core logic**: borrow, return, renew, list loans, stock + due-date rules. |
| `routes/api/index.js` | Mounts `/api`, JSON body parsing, 404 + error handler. |
| `routes/api/books.js` | `GET/POST/PUT/DELETE /api/books…` |
| `routes/api/loans.js` | `GET/POST/PUT/DELETE /api/loans…` |
| `routes/api/helpers.js` | Response envelope, pagination, query helpers. |
| `lib/apiError.js` | Error type with HTTP status + stable `code` for the frontend. |
| `lib/apiAuth.js` | Reads the session user, `requireUser` / `requireLibrarian` guards. |
| `lib/mongo.js` | Safe `ObjectId` conversion + driver result normalising. |
| `tests/api-smoke.js` | End-to-end smoke test for every endpoint and rule. |
| `docs/api-demo.sh` | The presentation demo as a runnable script. |

`server.js` is the integration point. It now contains Person 2's session + auth
routes, and the `/api` mount sits **below** the session middleware so the API can
read `req.session.user`. The API also parses its own JSON bodies (a broken body then
gets a JSON error answer instead of an HTML stack trace).

### Wiring in `server.js`

```js
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({                    // ← must stay ABOVE /api
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 2 }
}));
app.use(setUser);                    // res.locals.user for the EJS pages

app.use(authRoutes);                 // /login /register /logout   (Person 2)

// REST API (Person 3). The API parses its own JSON bodies, so a broken body
// still gets a JSON error instead of an HTML stack trace.
app.use('/api', apiRoutes);
app.use(express.json());             // JSON bodies for the page routes

app.get('/', ...);                   // redirect to /books or /login
app.get('/books', isLoggedIn, ...);  // placeholder until Person 4's catalog view
```

---

## 2. Authentication

Every API request must belong to a logged-in session (the catalog included), which
matches the "block unauthorized users" requirement. Logging in through Person 2's
`POST /login` route sets the cookie; the browser or `curl` then sends it back.

`routes/auth.js` stores this in the session on a successful login:

```js
req.session.user = {
    _id: user._id,        // used by the API to record who borrowed what
    username: user.username,
    name: user.name,
    role: user.role
};
```

The API only needs `_id` (or `id`) and `role`; `username`/`name` are used for display.
It also tolerates the flatter shape `req.session.userId / username / role`, so a
future refactor of the login route will not break the API.

> The old page-only session (`username`, `name`, `role`) did not carry an id. It was
> extended with `_id` during the merge so loans are keyed by the real user id instead
> of the username.

Roles: `member` can read and borrow/return. `librarian` (also `admin` / `staff`) can
additionally add, edit and delete books and loans. No session → `401`.

---

## 3. Response format

Every successful response:

```json
{
  "success": true,
  "message": "optional friendly message",
  "data": { },
  "pagination": { "page": 1, "limit": 20, "total": 5, "pages": 1 }
}
```

Every failure:

```json
{ "success": false, "error": "Out of stock! All copies of …", "code": "OUT_OF_STOCK" }
```

`code` is a stable value the frontend can switch on (see the table in section 5), so
Person 4 never has to match on the English text.

---

## 4. Endpoints

Base URL: `http://localhost:3000`

### 4.1 Books

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/books` | any logged-in user | List + search the catalog |
| `GET` | `/api/books/:id` | any logged-in user | One book |
| `POST` | `/api/books` | librarian | Add a book — `201` |
| `PUT` | `/api/books/:id` | librarian | Edit a book |
| `DELETE` | `/api/books/:id` | librarian | Remove a book (only if no copies are on loan) |

**Query parameters for `GET /api/books`**

| Parameter | Example | Meaning |
| --- | --- | --- |
| `search` | `?search=clean` | Partial, case-insensitive match on title, author or ISBN |
| `category` | `?category=Fiction` | Exact category |
| `available` | `?available=true` | Only books with at least one copy on the shelf |
| `page` | `?page=2` | Page number (default 1) |
| `limit` | `?limit=10` | Page size (default 20, maximum 100) |

**Book JSON**

```json
{
  "id": "6712ab…",
  "title": "Clean Code",
  "author": "Robert C. Martin",
  "isbn": "9780132350884",
  "category": "Technology",
  "totalCopies": 2,
  "availableCopies": 1,
  "onLoanCopies": 1,
  "inStock": true,
  "createdAt": "2026-11-19T…"
}
```

`availableCopies` is always maintained by the API — never send it yourself, it is
derived from `totalCopies` minus the active loans.

### 4.2 Loans

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/loans` | member: own / librarian: all | List loans |
| `GET` | `/api/loans/:id` | member: own / librarian: any | One loan |
| `POST` | `/api/loans` | any logged-in user | **Borrow** `{ "bookId": "…" }` — `201` |
| `PUT` | `/api/loans/:id/return` | member: own / librarian: any | **Return** the book |
| `PUT` | `/api/loans/:id` | librarian | Change a due date (renewal) |
| `DELETE` | `/api/loans/:id` | librarian | Delete a loan record (active loan returns the copy first) |

**Query parameters for `GET /api/loans`**

| Parameter | Example | Meaning |
| --- | --- | --- |
| `status` | `?status=active` | `active`, `returned`, `overdue` or `all` (default `all`) |
| `userId` | `?userId=…` | Librarian only: one member's loans |
| `bookId` | `?bookId=…` | Loans of one book |
| `page`, `limit` | | Same as books |

**Loan JSON**

```json
{
  "id": "6712cd…",
  "userId": "6712aa…",
  "username": "member1",
  "bookId": "6712ab…",
  "bookTitle": "Clean Code",
  "borrowedAt": "2026-11-19T14:00:00.000Z",
  "dueDate": "2026-12-03T14:00:00.000Z",
  "returnedAt": null,
  "loanDays": 14,
  "status": "active",
  "isOverdue": false,
  "overdueDays": 0,
  "wasOverdue": false
}
```

---

## 5. Business rules (the heart of Person 3's part)

**Borrowing — `POST /api/loans`**

1. The book must exist → otherwise `404 BOOK_NOT_FOUND`.
2. There must be a copy on the shelf → otherwise `409 OUT_OF_STOCK`
   ("Out of stock! All copies of … are currently on loan.").
3. The copy is reserved with a **conditional update**
   (`{ _id, availableCopies: { $gt: 0 } }` + `$inc: -1`). Two people clicking at the
   same moment can therefore never both get the last copy — the database decides the
   winner, not JavaScript.
4. The due date is `borrowedAt + LOAN_PERIOD_DAYS` (default **14 days**, set
   `LOAN_PERIOD_DAYS` in `.env` to change it).
5. A member cannot have two active loans of the same book. The partial unique index
   from `db/db.js` (`userId + bookId`, only while `returnedAt: null`) rejects it →
   `409 ALREADY_BORROWED`, and the reserved copy is put back.

**Returning — `PUT /api/loans/:id/return`**

1. The loan must exist (`404`) and belong to you unless you are the librarian (`403`).
2. Already returned → `400 ALREADY_RETURNED`.
3. The loan is closed with `{ returnedAt: null }` as a condition, so a double click
   cannot return the same copy twice and inflate the stock.
4. The copy is put back, **capped at `totalCopies`** so stock can never exceed what
   the library owns.

**Editing stock — `PUT /api/books/:id`**

* `availableCopies` is recalculated as `totalCopies − copies currently on loan`.
* Lowering `totalCopies` below the number of copies on loan is refused with
  `409 COPIES_ON_LOAN`.

**Deleting**

* A book with copies on loan cannot be deleted (`409 BOOK_ON_LOAN`) — the loan would
  point at nothing.
* Deleting an **active** loan record puts the copy back on the shelf first.

**Overdue loans** are not stored; they are computed on read (`dueDate < now`), so
`?status=overdue` always reflects "right now".

### Error codes

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing/blank field, bad `totalCopies`, … |
| 400 | `INVALID_ID` | The id in the URL/body is not a 24-char ObjectId |
| 400 | `INVALID_JSON` | The request body is not valid JSON |
| 400 | `ALREADY_RETURNED` | Returning the same loan twice |
| 400 | `LOAN_CLOSED` | Trying to renew a returned loan |
| 401 | `UNAUTHENTICATED` | No session — please log in |
| 403 | `FORBIDDEN` | Member trying a librarian action / someone else's loan |
| 404 | `BOOK_NOT_FOUND` / `LOAN_NOT_FOUND` | Unknown id |
| 404 | `ENDPOINT_NOT_FOUND` | Unknown `/api/...` path |
| 409 | `OUT_OF_STOCK` | No copy left — friendly message ready for the UI |
| 409 | `ALREADY_BORROWED` | Same book already on loan to this member |
| 409 | `DUPLICATE_ISBN` | ISBN already in the catalog |
| 409 | `COPIES_ON_LOAN` | `totalCopies` lower than the copies on loan |
| 409 | `BOOK_ON_LOAN` | Deleting a book that still has copies out |
| 500 | `INTERNAL_ERROR` | Anything unexpected (the real error is logged on the server) |

---

## 6. Running and testing

```bash
cp .env.example .env # then put your MONGO_URI / SESSION_SECRET in .env
npm install          # once
node seed.js         # demo data (Person 1)
node server.js       # http://localhost:3000  → redirects to /login
```

Log in with one of the seeded accounts (`librarian1` / `member1` / `member2`,
password `password123`), then the API is available with the same cookie.

End-to-end test of the API only (it starts its own server on a free port, and
fakes the session, so no login is needed):

```bash
node tests/api-smoke.js
# or point it at a specific database:
MONGO_URI="mongodb://127.0.0.1:27017" node tests/api-smoke.js
```

The smoke test covers 50+ checks: unauthenticated access, all four HTTP verbs,
search, stock changes, borrowing, the out-of-stock and already-borrowed conflicts,
returning twice, permissions, renewal, stock edits and deletion rules.

---

## 7. Presentation curl commands

The same steps are automated in `docs/api-demo.sh` (run it with `bash`). Run these
from the Ubuntu server or Git Bash, with the app running on port 3000.

```bash
BASE=http://localhost:3000

# ---------------------------------------------------------------
# 1. Not logged in -> the API refuses with 401
# ---------------------------------------------------------------
curl -s -i $BASE/api/books

# ---------------------------------------------------------------
# 2. Log in as the librarian; -c saves the session cookie in cookies.txt
# ---------------------------------------------------------------
curl -s -i -c cookies.txt -X POST $BASE/login \
     -d "username=librarian1" -d "password=password123"

# ---------------------------------------------------------------
# 3. Read the catalog (first 3 books)
# ---------------------------------------------------------------
curl -s -b cookies.txt "$BASE/api/books?limit=3"

# ---------------------------------------------------------------
# 4. Search just like the search bar on the page
# ---------------------------------------------------------------
curl -s -b cookies.txt "$BASE/api/books?search=clean"

# ---------------------------------------------------------------
# 5. Add a book (librarian only) -> 201 Created + Location header
# ---------------------------------------------------------------
curl -s -i -b cookies.txt -X POST $BASE/api/books \
     -H "Content-Type: application/json" \
     -d '{"title":"The Pragmatic Programmer","author":"Andrew Hunt","isbn":"9780201616224","category":"Technology","totalCopies":2}'

# ---------------------------------------------------------------
# 6. Edit that book (raise the number of copies)
# ---------------------------------------------------------------
curl -s -i -b cookies.txt -X PUT $BASE/api/books/<BOOK_ID> \
     -H "Content-Type: application/json" \
     -d '{"totalCopies":3}'

# ---------------------------------------------------------------
# 7. Log in as a member, then borrow the book -> 201 + due date
# ---------------------------------------------------------------
curl -s -i -c member.txt -X POST $BASE/login \
     -d "username=member1" -d "password=password123"

curl -s -i -b member.txt -X POST $BASE/api/loans \
     -H "Content-Type: application/json" \
     -d '{"bookId":"<BOOK_ID>"}'

# ---------------------------------------------------------------
# 8. Same member borrows it again -> 409 ALREADY_BORROWED
# ---------------------------------------------------------------
curl -s -i -b member.txt -X POST $BASE/api/loans \
     -H "Content-Type: application/json" \
     -d '{"bookId":"<BOOK_ID>"}'

# ---------------------------------------------------------------
# 9. Out of stock: "To Kill a Mockingbird" has only 1 copy.
#    member1 takes it, member2 tries -> 409 OUT_OF_STOCK
# ---------------------------------------------------------------
curl -s -i -c member2.txt -X POST $BASE/login \
     -d "username=member2" -d "password=password123"

curl -s -i -b member2.txt -X POST $BASE/api/loans \
     -H "Content-Type: application/json" \
     -d '{"bookId":"<MOCKINGBIRD_ID>"}'

# ---------------------------------------------------------------
# 10. Return a book -> stock goes back up
# ---------------------------------------------------------------
curl -s -i -b member.txt -X PUT $BASE/api/loans/<LOAN_ID>/return

# ---------------------------------------------------------------
# 11. The librarian sees every active loan
# ---------------------------------------------------------------
curl -s -b cookies.txt "$BASE/api/loans?status=active"

# ---------------------------------------------------------------
# 12. Delete a book -> 200 (or 409 BOOK_ON_LOAN if copies are out)
# ---------------------------------------------------------------
curl -s -i -b cookies.txt -X DELETE $BASE/api/books/<BOOK_ID>
```

> **Windows tip:** `curl` in PowerShell is an alias for `Invoke-WebRequest` in old
> versions — call `curl.exe` instead, and use `--data-urlencode "username=member1"`
> style quoting if your shell mangles the `-d` values.

---

## 8. Integration notes for the rest of the group

**Person 2 (auth)** — merged. `/login`, `/register`, `/logout` and the session
middleware are in `server.js`, and `routes/auth.js` now also stores `_id` (see
section 2). The API never touches passwords, it only reads `req.session`.

**Person 4 (UI)** — the catalog page can be powered by `GET /api/books?search=…`
(pagination included), and the borrow button by `POST /api/loans`. Show
`error.message` directly and use `error.code` for special styling, e.g.
`OUT_OF_STOCK` → red "Out of stock!" banner, `ALREADY_BORROWED` → "You already have
this book". A `409` is a normal business answer, not a crash.

**Person 5 (deployment/QA)** — nothing to configure beyond `MONGO_URI`; optional
`LOAN_PERIOD_DAYS` (default 14) and `PORT`. Run `node tests/api-smoke.js` as part of
the QA checklist, and `bash docs/api-demo.sh` once against the deployed server to be
sure the demo works end-to-end (`BASE=https://… bash docs/api-demo.sh`).
