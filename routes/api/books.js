'use strict';

const express = require('express');
const bookService = require('../../services/bookService');
const { requireUser, requireLibrarian } = require('../../lib/apiAuth');
const { sendData, pagination, meta, queryBoolean } = require('./helpers');

const router = express.Router();

/**
 * GET /api/books
 * Optional query: search, category, available=true, page, limit
 * Books are readable by any logged-in member; changing the catalog is librarian only.
 */
router.get('/', async (req, res) => {
    requireUser(req);

    const { page, limit } = pagination(req.query);
    const { items, total } = await bookService.listBooks({
        search: req.query.search,
        category: req.query.category,
        onlyAvailable: queryBoolean(req.query.available),
        page,
        limit
    });

    sendData(res, items, { extra: { pagination: meta(total, page, limit) } });
});

/** GET /api/books/:id */
router.get('/:id', async (req, res) => {
    requireUser(req);
    sendData(res, await bookService.getBook(req.params.id));
});

/** POST /api/books — add a book (librarian only). */
router.post('/', async (req, res) => {
    requireLibrarian(req);

    const book = await bookService.createBook(req.body);
    res.location(`/api/books/${book.id}`);
    sendData(res, book, { status: 201, message: `"${book.title}" was added to the catalog.` });
});

/** PUT /api/books/:id — edit a book (librarian only). */
router.put('/:id', async (req, res) => {
    requireLibrarian(req);

    const book = await bookService.updateBook(req.params.id, req.body);
    sendData(res, book, { message: `"${book.title}" was updated.` });
});

/** DELETE /api/books/:id — remove a book (librarian only, no copies on loan). */
router.delete('/:id', async (req, res) => {
    requireLibrarian(req);

    const book = await bookService.deleteBook(req.params.id);
    sendData(res, book, { message: `"${book.title}" was removed from the catalog.` });
});

module.exports = router;
