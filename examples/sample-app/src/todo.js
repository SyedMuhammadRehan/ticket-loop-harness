'use strict';

function createTodo(title, dueDate = null) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('a todo needs a title');
  return { title: title.trim(), dueDate, done: false };
}

function completeTodo(todo) {
  return { ...todo, done: true };
}

function listOpen(todos) {
  return todos.filter((todo) => !todo.done);
}

module.exports = { createTodo, completeTodo, listOpen };
