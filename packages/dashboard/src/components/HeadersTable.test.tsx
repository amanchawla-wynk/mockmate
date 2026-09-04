import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  HeadersTable,
  responseHeaderRowsToRecord,
  responseHeadersToRows,
  type HeaderRow,
} from './HeadersTable';

it('renders canonical Endpoint matcher and Variant response headers separately', () => {
  render(
    <>
      <HeadersTable
        label="Endpoint matcher headers"
        rows={[{ id: 'matcher', name: 'x-plan', value: 'paid' }]}
        onChange={vi.fn()}
      />
      <HeadersTable
        label="Variant response headers"
        rows={[{ id: 'response', name: 'x-mock', value: 'yes' }]}
        onChange={vi.fn()}
      />
    </>,
  );
  expect(screen.getByRole('heading', { name: 'Endpoint matcher headers' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Variant response headers' })).toBeVisible();
});

describe('response header row conversion', () => {
  it('expands scalar and repeated values in source order', () => {
    expect(responseHeadersToRows({
      'content-type': 'application/json',
      'set-cookie': ['session=one', 'theme=dark'],
    }).map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'content-type', value: 'application/json' },
      { name: 'set-cookie', value: 'session=one' },
      { name: 'set-cookie', value: 'theme=dark' },
    ]);
  });

  it('groups names case-insensitively using first-seen casing and value order', () => {
    expect(responseHeaderRowsToRecord([
      { id: '1', name: 'Set-Cookie', value: 'session=one' },
      { id: '2', name: 'set-cookie', value: 'theme=dark' },
      { id: '3', name: 'Content-Type', value: 'application/json' },
    ])).toEqual({
      'Set-Cookie': ['session=one', 'theme=dark'],
      'Content-Type': 'application/json',
    });
  });

  it.each(['', '   '])('rejects the blank header name %j', name => {
    expect(() => responseHeaderRowsToRecord([{ id: '1', name, value: 'value' }]))
      .toThrow('Header name is required');
  });
});

it('keeps duplicate blank rows independently editable and emits ordered rows', async () => {
  const onChange = vi.fn();

  function EditableHeaders() {
    const [rows, setRows] = useState<HeaderRow[]>([]);
    return (
      <HeadersTable
        label="Variant response headers"
        rows={rows}
        onChange={nextRows => {
          onChange(nextRows);
          setRows(nextRows);
        }}
      />
    );
  }

  render(<EditableHeaders />);
  await userEvent.click(screen.getByRole('button', { name: 'Add Header' }));
  await userEvent.click(screen.getByRole('button', { name: 'Add Header' }));

  const addedRows = onChange.mock.calls.at(-1)?.[0] as HeaderRow[];
  expect(addedRows).toHaveLength(2);
  expect(addedRows[0]?.id).not.toBe(addedRows[1]?.id);
  expect(addedRows.map(({ name, value }) => ({ name, value }))).toEqual([
    { name: '', value: '' },
    { name: '', value: '' },
  ]);

  fireEvent.change(screen.getAllByPlaceholderText('Content-Type')[1], {
    target: { value: 'Set-Cookie' },
  });
  fireEvent.change(screen.getAllByPlaceholderText('application/json')[0], {
    target: { value: 'first' },
  });

  const editedRows = onChange.mock.calls.at(-1)?.[0] as HeaderRow[];
  expect(editedRows.map(row => row.id)).toEqual(addedRows.map(row => row.id));
  expect(editedRows.map(({ name, value }) => ({ name, value }))).toEqual([
    { name: '', value: 'first' },
    { name: 'Set-Cookie', value: '' },
  ]);

  await userEvent.click(screen.getAllByTitle('Delete header')[0]);
  expect(onChange).toHaveBeenLastCalledWith([editedRows[1]]);
});
