'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTodo, completeTodo, listOpen } = require('../src/todo.js');

test('a new todo is open and keeps its trimmed title', () => {
  const todo = createTodo('  write the report  ');
  assert.strictEqual(todo.title, 'write the report');
  assert.strictEqual(todo.done, false);
});

test('a todo with no title is refused', () => {
  assert.throws(() => createTodo('   '), /needs a title/);
});

test('completing a todo returns a new one and leaves the original open', () => {
  const todo = createTodo('call the bank');
  const done = completeTodo(todo);
  assert.strictEqual(done.done, true);
  assert.strictEqual(todo.done, false);
});

test('listOpen returns only the todos not yet done', () => {
  const a = createTodo('a');
  const b = completeTodo(createTodo('b'));
  assert.deepStrictEqual(listOpen([a, b]), [a]);
});
