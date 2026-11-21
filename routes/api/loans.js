'use strict';

const express = require('express');
const loanService = require('../../services/loanService');
const { requireUser, requireLibrarian } = require('../../lib/apiAuth');
const { sendData, pagination, meta } = require('./helpers');

const router = express.Router();

/**
 * GET /api/loans?status=active|returned|overdue|all&userId=&bookId=&page=&limit=
 * A member only ever sees their own loans; the librarian sees everyone's.
 */
router.get('/', async (req, res) => {
    const user = requireUser(req);

    const { page, limit } = pagination(req.query);
    const { items, total } = await loanService.listLoans(user, {
        status: req.query.status,
        userId: req.query.userId,
        bookId: req.query.bookId,
        page,
        limit
    });

    sendData(res, items, { extra: { pagination: meta(total, page, limit) } });
});

/** GET /api/loans/:id */
router.get('/:id', async (req, res) => {
    const user = requireUser(req);
    sendData(res, await loanService.getLoan(user, req.params.id));
});

/**
 * POST /api/loans — borrow a book.
 * Body: { "bookId": "<24 character id>" }
 */
router.post('/', async (req, res) => {
    const user = requireUser(req);

    const { loan, book } = await loanService.borrowBook(user, req.body && req.body.bookId);
    res.location(`/api/loans/${loan.id}`);
    sendData(res, { loan, book }, {
        status: 201,
        message: `"${loan.bookTitle}" is yours until ${new Date(loan.dueDate).toDateString()}.`
    });
});

/**
 * PUT /api/loans/:id/return — give the book back.
 * Declared before /:id so the intent is obvious when reading the file.
 */
router.put('/:id/return', async (req, res) => {
    const user = requireUser(req);

    const { loan, book } = await loanService.returnLoan(user, req.params.id);
    sendData(res, { loan, book }, { message: `"${loan.bookTitle}" was returned. Thank you!` });
});

/**
 * PUT /api/loans/:id — librarian changes a due date (renewal or correction).
 * Body: { "dueDate": "2026-12-01" } or { "extendDays": 7 }
 */
router.put('/:id', async (req, res) => {
    requireLibrarian(req);

    const loan = await loanService.changeDueDate(req.params.id, req.body || {});
    sendData(res, loan, { message: `The due date is now ${new Date(loan.dueDate).toDateString()}.` });
});

/** DELETE /api/loans/:id — librarian removes a loan record (active loans return the copy first). */
router.delete('/:id', async (req, res) => {
    requireLibrarian(req);

    const loan = await loanService.deleteLoan(req.params.id);
    sendData(res, loan, { message: 'The loan record was deleted.' });
});

module.exports = router;
