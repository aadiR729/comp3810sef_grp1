'use strict';

/**
 * End-to-end smoke test for the REST API built in Person 3's part.
 *
 * It starts the API on a random free port (no need to run server.js), talks to it
 * with plain HTTP like the frontend/curl would, and checks the borrow/return rules
 * against a real MongoDB database.
 *
 * Usage (from the project folder):
 *   node tests/api-smoke.js
 *
 * The connection string comes from MONGO_URI in .env, or you can pass it inline:
 *   MONGO_URI="mongodb://127.0.0.1:27017" node tests/api-smoke.js
 *
 * It only creates and deletes its OWN test books/loans, but please point it at a
 * throwaway database anyway (it assumes the "library_db" database, same as db.js).
 */

require('dotenv').config({ quiet: true });

const express = require('express');
const { connectDB, getDB } = require('../db/db');
const apiRoutes = require('../routes/api');

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';

// Fake sessions: the API only reads req.session.user, so this stands in for
// Person 2's login + express-session while testing Person 3's part alone.
const USERS = {
    librarian1: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'librarian1', role: 'librarian' },
    member1: { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', username: 'member1', role: 'member' },
    member2: { _id: 'cccccccccccccccccccccccc', username: 'member2', role: 'member' }
};

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
    checks += 1;
    if (condition) {
        console.log(`  ✅ ${name}`);
    } else {
        failures += 1;
        console.log(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

async function main() {
    await connectDB();

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
        const who = req.get('x-test-user');
        req.session = who && USERS[who] ? { user: USERS[who] } : {};
        next();
    });
    // Same order as server.js: the API parses its own JSON bodies.
    app.use('/api', apiRoutes);
    app.use(express.json());

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, pathname, { user, body, rawBody, contentType = 'application/json' } = {}) {
        const headers = {};
        if (user) headers['x-test-user'] = user;
        if (body !== undefined || rawBody !== undefined) headers['content-type'] = contentType;

        const response = await fetch(base + pathname, {
            method,
            headers,
            body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body)
        });

        let json = null;
        try {
            json = await response.json();
        } catch {
            json = null;
        }
        return { status: response.status, body: json, headers: response.headers };
    }

    const stamp = Date.now();
    const createdBookIds = [];
    let bookA = null;
    let bookB = null;
    let member1Loan = null;
    let member2Loan = null;

    try {
        section('Authentication (401 before login)');
        const anonymous = await call('GET', '/api/books');
        check('GET /api/books without a session -> 401', anonymous.status === 401, anonymous.body);
        check('error code is UNAUTHENTICATED', anonymous.body && anonymous.body.code === 'UNAUTHENTICATED', anonymous.body);

        section('Catalog: GET /api/books');
        const list = await call('GET', '/api/books?limit=5', { user: 'member1' });
        check('logged-in member can read the catalog -> 200', list.status === 200, list.body);
        check('response is an array of books', Array.isArray(list.body && list.body.data), list.body);
        check('pagination block is present', Boolean(list.body && list.body.pagination), list.body);

        section('Catalog: POST /api/books (librarian only)');
        const forbidden = await call('POST', '/api/books', {
            user: 'member1',
            body: { title: 'Nope', author: 'Nope', isbn: 'x' }
        });
        check('member cannot add a book -> 403', forbidden.status === 403, forbidden.body);

        const isbnA = `TEST-A-${stamp}`;
        const createdA = await call('POST', '/api/books', {
            user: 'librarian1',
            body: { title: `Test Book Alpha ${stamp}`, author: 'QA Bot', isbn: isbnA, category: 'Testing', totalCopies: 2 }
        });
        check('librarian can add a book -> 201', createdA.status === 201, createdA.body);
        bookA = createdA.body && createdA.body.data;
        if (bookA) createdBookIds.push(bookA.id);
        check('new book has both copies available', Boolean(bookA) && bookA.availableCopies === 2, bookA);
        check(
            'Location header points at the new book',
            Boolean(createdA.headers.get('location')) && createdA.headers.get('location').endsWith(bookA.id),
            createdA.headers.get('location')
        );

        const duplicate = await call('POST', '/api/books', {
            user: 'librarian1',
            body: { title: 'Duplicate ISBN', author: 'QA Bot', isbn: isbnA, totalCopies: 1 }
        });
        check('duplicate ISBN -> 409', duplicate.status === 409, duplicate.body);
        check('duplicate ISBN code is DUPLICATE_ISBN', duplicate.body && duplicate.body.code === 'DUPLICATE_ISBN', duplicate.body);

        section('Catalog: search / available filter / single book');
        const search = await call('GET', `/api/books?search=${encodeURIComponent('Alpha ' + stamp)}`, { user: 'member1' });
        check('search finds the new book', Boolean(search.body) && search.body.data.some((b) => b.id === bookA.id), search.body);

        const onlyAvailable = await call('GET', '/api/books?available=true&limit=100', { user: 'member1' });
        check(
            'available=true only lists books with copies',
            Boolean(onlyAvailable.body) && onlyAvailable.body.data.every((b) => b.availableCopies > 0),
            onlyAvailable.body && onlyAvailable.body.data && onlyAvailable.body.data.slice(0, 3)
        );

        const one = await call('GET', `/api/books/${bookA.id}`, { user: 'member1' });
        check('GET /api/books/:id works -> 200', one.status === 200 && one.body.data.id === bookA.id, one.body);

        const badId = await call('GET', '/api/books/not-an-id', { user: 'member1' });
        check('malformed id -> 400 INVALID_ID', badId.status === 400 && badId.body.code === 'INVALID_ID', badId.body);

        section('Borrowing: POST /api/loans');
        const borrow1 = await call('POST', '/api/loans', { user: 'member1', body: { bookId: bookA.id } });
        check('member borrows a copy -> 201', borrow1.status === 201, borrow1.body);
        member1Loan = borrow1.body && borrow1.body.data && borrow1.body.data.loan;
        check('loan status is active', Boolean(member1Loan) && member1Loan.status === 'active', member1Loan);

        const dueInDays = member1Loan
            ? Math.round((new Date(member1Loan.dueDate) - Date.now()) / 86400000)
            : null;
        check('due date is 14 days away', dueInDays === 14, { dueInDays, dueDate: member1Loan && member1Loan.dueDate });

        const stockAfterBorrow = await call('GET', `/api/books/${bookA.id}`, { user: 'member1' });
        check('stock went down to 1', stockAfterBorrow.body.data.availableCopies === 1, stockAfterBorrow.body.data);

        const borrowSameAgain = await call('POST', '/api/loans', { user: 'member1', body: { bookId: bookA.id } });
        check('same member cannot borrow the same book twice -> 409', borrowSameAgain.status === 409, borrowSameAgain.body);
        check('code is ALREADY_BORROWED', borrowSameAgain.body && borrowSameAgain.body.code === 'ALREADY_BORROWED', borrowSameAgain.body);

        const borrow2 = await call('POST', '/api/loans', { user: 'member2', body: { bookId: bookA.id } });
        check('second member takes the last copy -> 201', borrow2.status === 201, borrow2.body);
        member2Loan = borrow2.body && borrow2.body.data && borrow2.body.data.loan;

        const outOfStock = await call('POST', '/api/loans', { user: 'librarian1', body: { bookId: bookA.id } });
        check('no copies left -> 409 OUT_OF_STOCK', outOfStock.status === 409, outOfStock.body);
        check('friendly out-of-stock message', Boolean(outOfStock.body) && /out of stock/i.test(outOfStock.body.error), outOfStock.body);

        const missingBook = await call('POST', '/api/loans', { user: 'member1', body: { bookId: 'ffffffffffffffffffffffff' } });
        check('unknown book -> 404 BOOK_NOT_FOUND', missingBook.status === 404 && missingBook.body.code === 'BOOK_NOT_FOUND', missingBook.body);

        const noBody = await call('POST', '/api/loans', { user: 'member1', body: {} });
        check('missing bookId -> 400', noBody.status === 400, noBody.body);

        section('Listing loans');
        const myLoans = await call('GET', '/api/loans?status=active', { user: 'member1' });
        check('member sees only their own loans', Boolean(myLoans.body) && myLoans.body.data.every((l) => l.userId === USERS.member1._id), myLoans.body);
        check('member1 has exactly one active loan', Boolean(myLoans.body) && myLoans.body.data.length === 1, myLoans.body && myLoans.body.data.length);

        const allLoans = await call('GET', '/api/loans?status=active&limit=100', { user: 'librarian1' });
        check(
            'librarian sees both active loans',
            Boolean(allLoans.body) &&
                ['bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc'].every((id) =>
                    allLoans.body.data.some((l) => l.userId === id)
                ),
            allLoans.body && allLoans.body.data.map((l) => l.userId)
        );

        const otherLoan = await call('GET', `/api/loans/${member2Loan.id}`, { user: 'member1' });
        check("member cannot read another member's loan -> 403", otherLoan.status === 403, otherLoan.body);

        section('Renewal: PUT /api/loans/:id (librarian)');
        const renew = await call('PUT', `/api/loans/${member1Loan.id}`, { user: 'librarian1', body: { extendDays: 7 } });
        check('librarian extends the due date -> 200', renew.status === 200, renew.body);
        const newDueInDays = renew.body && renew.body.data ? Math.round((new Date(renew.body.data.dueDate) - Date.now()) / 86400000) : null;
        check('due date moved roughly a week later', newDueInDays === 21, { newDueInDays });

        const renewByMember = await call('PUT', `/api/loans/${member1Loan.id}`, { user: 'member1', body: { extendDays: 7 } });
        check('member cannot change a due date -> 403', renewByMember.status === 403, renewByMember.body);

        section('Editing stock: PUT /api/books/:id');
        const shrinkTooFar = await call('PUT', `/api/books/${bookA.id}`, { user: 'librarian1', body: { totalCopies: 1 } });
        check('cannot shrink below copies on loan -> 409 COPIES_ON_LOAN', shrinkTooFar.status === 409 && shrinkTooFar.body.code === 'COPIES_ON_LOAN', shrinkTooFar.body);

        const grow = await call('PUT', `/api/books/${bookA.id}`, {
            user: 'librarian1',
            body: { totalCopies: 4, category: 'Quality Assurance' }
        });
        check('librarian can raise total copies -> 200', grow.status === 200, grow.body);
        check('available copies follow the total (4 - 2 on loan = 2)', grow.body.data.availableCopies === 2, grow.body.data);

        section('Deleting a book while copies are on loan');
        const isbnB = `TEST-B-${stamp}`;
        const createdB = await call('POST', '/api/books', {
            user: 'librarian1',
            body: { title: `Test Book Beta ${stamp}`, author: 'QA Bot', isbn: isbnB, totalCopies: 1 }
        });
        bookB = createdB.body && createdB.body.data;
        if (bookB) createdBookIds.push(bookB.id);

        const borrowB = await call('POST', '/api/loans', { user: 'member1', body: { bookId: bookB.id } });
        check('borrow the only copy of book B -> 201', borrowB.status === 201, borrowB.body);
        const loanB = borrowB.body && borrowB.body.data && borrowB.body.data.loan;

        const deleteBusy = await call('DELETE', `/api/books/${bookB.id}`, { user: 'librarian1' });
        check('cannot delete a book on loan -> 409 BOOK_ON_LOAN', deleteBusy.status === 409 && deleteBusy.body.code === 'BOOK_ON_LOAN', deleteBusy.body);

        section('Returning: PUT /api/loans/:id/return');
        const wrongUserReturn = await call('PUT', `/api/loans/${member2Loan.id}/return`, { user: 'member1' });
        check("member cannot return another member's book -> 403", wrongUserReturn.status === 403, wrongUserReturn.body);

        const returned = await call('PUT', `/api/loans/${member2Loan.id}/return`, { user: 'member2' });
        check('member2 returns the book -> 200', returned.status === 200, returned.body);
        check('loan is marked returned', Boolean(returned.body) && returned.body.data.loan.status === 'returned', returned.body && returned.body.data.loan);
        check('stock is back to 3', returned.body.data.book.availableCopies === 3, returned.body.data.book);

        const returnTwice = await call('PUT', `/api/loans/${member2Loan.id}/return`, { user: 'member2' });
        check('returning twice -> 400 ALREADY_RETURNED', returnTwice.status === 400 && returnTwice.body.code === 'ALREADY_RETURNED', returnTwice.body);

        const stockCapped = await call('GET', `/api/books/${bookA.id}`, { user: 'member1' });
        check('stock never exceeds total copies', stockCapped.body.data.availableCopies <= stockCapped.body.data.totalCopies, stockCapped.body.data);

        section('Librarian deletes an active loan (copy goes back on the shelf)');
        const deleteLoanB = await call('DELETE', `/api/loans/${loanB.id}`, { user: 'librarian1' });
        check('librarian deletes an active loan -> 200', deleteLoanB.status === 200, deleteLoanB.body);

        const bookBAfter = await call('GET', `/api/books/${bookB.id}`, { user: 'member1' });
        check('deleting the loan restored the stock', bookBAfter.body.data.availableCopies === 1, bookBAfter.body.data);

        section('DELETE /api/books/:id');
        const deleteB = await call('DELETE', `/api/books/${bookB.id}`, { user: 'librarian1' });
        check('book with no active loans can be deleted -> 200', deleteB.status === 200, deleteB.body);

        const goneB = await call('GET', `/api/books/${bookB.id}`, { user: 'member1' });
        check('deleted book is gone -> 404', goneB.status === 404, goneB.body);

        section('Misc: 404 and malformed JSON');
        const unknown = await call('GET', '/api/does-not-exist', { user: 'member1' });
        check('unknown endpoint -> 404 ENDPOINT_NOT_FOUND', unknown.status === 404 && unknown.body.code === 'ENDPOINT_NOT_FOUND', unknown.body);

        const brokenJson = await call('POST', '/api/books', { user: 'librarian1', rawBody: '{not json' });
        check('malformed JSON -> 400 INVALID_JSON', brokenJson.status === 400 && brokenJson.body.code === 'INVALID_JSON', brokenJson.body);

        section('Clean up: DELETE the remaining loan and book');
        const closeLoan = await call('PUT', `/api/loans/${member1Loan.id}/return`, { user: 'member1' });
        check('member1 returns the book -> 200', closeLoan.status === 200, closeLoan.body);

        const deleteA = await call('DELETE', `/api/books/${bookA.id}`, { user: 'librarian1' });
        check('librarian deletes book A -> 200', deleteA.status === 200, deleteA.body);

        const deleteLoanA = await call('DELETE', `/api/loans/${member1Loan.id}`, { user: 'librarian1' });
        check('librarian deletes the loan record -> 200', deleteLoanA.status === 200, deleteLoanA.body);
    } finally {
        // Belt and braces: never leave test data behind, even if an expectation failed.
        try {
            const db = getDB();
            const ids = createdBookIds.filter(Boolean).map((id) => new (require('mongodb').ObjectId)(id));
            if (ids.length) {
                await db.collection('loans').deleteMany({ bookId: { $in: ids } });
                await db.collection('books').deleteMany({ _id: { $in: ids } });
            }
        } catch (error) {
            console.log('  (cleanup failed:', error.message, ')');
        } finally {
            server.close();
        }
    }

    console.log(`\n${'-'.repeat(60)}`);
    console.log(`${checks - failures}/${checks} checks passed.`);
    if (failures > 0) {
        console.log(`❌ ${failures} check(s) failed.`);
    } else {
        console.log('✅ All API smoke checks passed.');
    }

    // The MongoDB driver keeps its sockets open, so the process would otherwise
    // hang forever. Give stdout a moment to flush, then exit with the result.
    setTimeout(() => process.exit(failures > 0 ? 1 : 0), 100);
}

main().catch((error) => {
    console.error('❌ Smoke test crashed:', error);
    setTimeout(() => process.exit(1), 100);
});
