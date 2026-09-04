import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, importApi } from '../../api/client';
import type { ImportPreview, ImportPreviewItem } from '../../api/types';
import { ImportWizard, type ImportWizardProps } from './ImportWizard';

function item(overrides: Partial<ImportPreviewItem> = {}): ImportPreviewItem {
  return {
    id: 'create-item',
    memberIds: ['member-create'],
    locations: [{ type: 'postman', itemPath: [0, 1] }],
    breadcrumbs: [['Users', 'Primary']],
    name: 'Create users',
    baseUrl: 'https://api.example.test:8443',
    matcher: { method: 'POST', path: '/users' },
    requests: [{
      scheme: 'https',
      hostname: 'api.example.test',
      port: '8443',
      query: [{ name: 'access_token', value: '[REDACTED]' }],
      headers: [{ name: 'Authorization', value: '[REDACTED]' }],
      auth: { type: 'bearer', fields: [{ name: 'token', value: '[REDACTED]' }] },
      body: { mediaType: 'application/json', byteCount: 24, omitted: true },
    }],
    responses: [{
      name: 'Created',
      status: 201,
      responseHeaders: { 'content-type': 'application/json' },
      body: { kind: 'sha256', sha256: 'ab'.repeat(32), byteCount: 12 },
      identity: 'created-response',
    }],
    proposedAction: 'create',
    allowedActions: ['create', 'skip'],
    exactTargets: [],
    overlaps: [],
    warnings: [],
    errors: [],
    selectedByDefault: true,
    createEffect: { createsEndpoint: true, createsVariants: 1 },
    ...overrides,
  };
}

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    snapshotToken: 'snapshot-1',
    sourceType: 'curl',
    items: [item()],
    unresolvedMembers: [],
    unresolvedVariables: [],
    warnings: [],
    discoveredOrigins: ['https://api.example.test'],
    affectedStates: [{ id: 'state-1', name: 'Signed in' }],
    summary: { valid: 1, invalid: 0, create: 1, merge: 0, skip: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function runBeforePassiveEffects(operation: () => Promise<void>) {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await operation();
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

function props(overrides: Partial<ImportWizardProps> = {}): ImportWizardProps {
  return {
    isOpen: true,
    projectId: 'project-1',
    onDirtyChange: vi.fn(),
    onRequestClose: vi.fn(),
    onCommitted: vi.fn().mockResolvedValue(undefined),
    onCommitOutcomeUnknown: vi.fn().mockResolvedValue(undefined),
    onSettlementChange: vi.fn(),
    onViewEndpoints: vi.fn(),
    ...overrides,
  };
}

async function openReview(
  value = preview(),
  wizardProps = props(),
  wizard: ReactNode = <ImportWizard {...wizardProps} />,
) {
  vi.spyOn(importApi, 'preview').mockResolvedValue(value);
  const user = userEvent.setup();
  const { rerender } = render(wizard);
  await user.type(
    screen.getByRole('textbox', { name: 'cURL commands' }),
    "curl -H 'Authorization: super-secret' https://api.example.test/users",
  );
  await user.click(screen.getByRole('button', { name: 'Preview import' }));
  await waitFor(() => {
    expect(
      screen.queryByRole('heading', { name: 'Review import' })
        ?? screen.queryByRole('heading', { name: 'Resolve import issues' }),
    ).not.toBeNull();
  });
  if (screen.queryByRole('heading', { name: 'Resolve import issues' })) {
    await user.click(screen.getByRole('button', { name: 'Continue to review' }));
  }
  await screen.findByRole('heading', { name: 'Review import' });
  return { user, wizardProps, rerender };
}

interface ProjectSwitchRaceHarnessProps {
  wizardProps: ImportWizardProps;
  switchProjectRef: { current(): void };
  onProjectCommit(): void;
}

function ProjectSwitchRaceHarness({
  wizardProps,
  switchProjectRef,
  onProjectCommit,
}: ProjectSwitchRaceHarnessProps) {
  const [projectId, setProjectId] = useState(wizardProps.projectId);

  useLayoutEffect(() => {
    switchProjectRef.current = () => setProjectId('project-2');
  }, [switchProjectRef]);

  useLayoutEffect(() => {
    if (projectId === wizardProps.projectId) return;
    onProjectCommit();
  }, [onProjectCommit, projectId, wizardProps.projectId]);

  return <ImportWizard {...wizardProps} projectId={projectId} />;
}

function expectOnlySourceStep() {
  expect(screen.getByRole('heading', { name: 'Choose a source' })).toBeVisible();
  expect(screen.getByText('1. Source').closest('li')).toHaveAttribute('aria-current', 'step');
  expect(screen.getByRole('tab', { name: 'cURL' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Close import' })).toBeEnabled();
  expect(screen.queryByRole('heading', { name: 'Review import' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Refreshing dashboard data' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Dashboard refresh failed' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View Endpoints' })).not.toBeInTheDocument();
  expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument();
}

describe('ImportWizard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses roving keyboard tabs and focuses each newly rendered step', async () => {
    const invalid = item({
      id: 'invalid-item',
      errors: [{ code: 'IMPORT_METHOD_UNSUPPORTED', message: 'TRACE is unsupported' }],
      selectedByDefault: false,
      proposedAction: 'skip',
      allowedActions: ['skip'],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    vi.spyOn(importApi, 'preview')
      .mockResolvedValueOnce(preview({
        items: [item(), invalid],
        unresolvedVariables: [{ name: 'tenant', memberIds: ['member-create'] }],
      }))
      .mockResolvedValueOnce(preview({ items: [item(), invalid] }));
    const user = userEvent.setup();
    render(<ImportWizard {...props()} />);
    const curlTab = screen.getByRole('tab', { name: 'cURL' });
    const postmanTab = screen.getByRole('tab', { name: 'Postman' });

    expect(curlTab).toHaveFocus();
    expect(curlTab).toHaveAttribute('tabindex', '0');
    expect(postmanTab).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{ArrowRight}');
    expect(postmanTab).toHaveFocus();
    expect(postmanTab).toHaveAttribute('aria-selected', 'true');
    expect(postmanTab).toHaveAttribute('tabindex', '0');
    await user.keyboard('{ArrowLeft}');
    expect(curlTab).toHaveFocus();
    expect(curlTab).toHaveAttribute('aria-selected', 'true');

    await user.type(screen.getByRole('textbox', { name: 'cURL commands' }), 'curl https://{{tenant}}.test');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    const variable = await screen.findByRole('textbox', { name: 'tenant' });
    expect(variable).toHaveFocus();
    await user.type(variable, 'acme');
    await user.click(screen.getByRole('button', { name: 'Continue to review' }));
    const reviewHeading = await screen.findByRole('heading', { name: 'Review import' });
    expect(reviewHeading).toHaveFocus();
  });

  it('accepts pasted cURL commands and renders a row-shaped preview skeleton', async () => {
    const pending = deferred<ImportPreview>();
    vi.spyOn(importApi, 'preview').mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<ImportWizard {...props()} />);

    expect(screen.getByRole('tab', { name: 'cURL' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Postman' })).toHaveAttribute('aria-selected', 'false');
    const commands = screen.getByRole('textbox', { name: 'cURL commands' });
    await user.type(commands, 'curl https://one.test/users\ncurl https://two.test/orders');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    const loading = screen.getByLabelText('Loading import preview');
    expect(within(loading).getByText('Request')).toBeVisible();
    expect(within(loading).getAllByTestId('preview-skeleton-row')).toHaveLength(3);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    await act(async () => pending.resolve(preview()));
  });

  it('accepts one JSON file by selection or drop and preserves invalid JSON for correction', async () => {
    const user = userEvent.setup();
    render(<ImportWizard {...props()} />);
    await user.click(screen.getByRole('tab', { name: 'Postman' }));
    const input = screen.getByLabelText('Postman collection file');
    expect(input).toHaveAttribute('accept', '.json,application/json');
    expect(input).not.toHaveAttribute('multiple');
    const invalid = new File(['not-json'], 'broken.json', { type: 'application/json' });
    Object.defineProperty(invalid, 'text', { value: () => Promise.resolve('not-json') });

    await user.upload(input, invalid);

    expect(screen.getByText('broken.json')).toBeVisible();
    expect(screen.getByText(/valid JSON/i)).toHaveAttribute('role', 'alert');

    const valid = new File(['{}'], 'collection.json', { type: 'application/json' });
    Object.defineProperty(valid, 'text', { value: () => Promise.resolve('{}') });
    fireEvent.drop(screen.getByTestId('postman-drop-zone'), {
      dataTransfer: { files: [valid] },
    });
    await screen.findByText('collection.json');
  });

  it('shows Resolve only when needed and reruns preview with labeled variable values', async () => {
    const invalid = item({
      id: 'invalid-item',
      name: 'Unsupported trace',
      errors: [{ code: 'IMPORT_METHOD_UNSUPPORTED', message: 'TRACE is unsupported' }],
      selectedByDefault: true,
      proposedAction: 'skip',
      allowedActions: ['skip'],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    vi.spyOn(importApi, 'preview')
      .mockResolvedValueOnce(preview({
        items: [item(), invalid],
        unresolvedVariables: [{ name: 'tenant', memberIds: ['member-create'] }],
      }))
      .mockResolvedValueOnce(preview({ items: [item(), invalid] }));
    const user = userEvent.setup();
    render(<ImportWizard {...props()} />);
    await user.type(screen.getByRole('textbox', { name: 'cURL commands' }), 'curl https://{{tenant}}.test');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByRole('heading', { name: 'Resolve import issues' })).toBeVisible();
    const variable = screen.getByRole('textbox', { name: 'tenant' });
    expect(screen.getByText('Used in 1 source request.')).toBeVisible();
    const invalidRow = screen.getByText('Unsupported trace').closest('li');
    expect(invalidRow).not.toBeNull();
    expect(within(invalidRow!).getByRole('checkbox')).toBeDisabled();
    await user.type(variable, 'acme');
    await user.click(screen.getByRole('button', { name: 'Continue to review' }));

    expect(await screen.findByRole('heading', { name: 'Review import' })).toBeVisible();
    expect(importApi.preview).toHaveBeenLastCalledWith(
      'project-1',
      expect.objectContaining({ variables: { tenant: 'acme' } }),
      expect.any(AbortSignal),
    );
    expect(screen.getByText('Unsupported trace')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Unsupported trace' })).toBeDisabled();
  });

  it('keeps collection warnings visible when a preview has no request rows', async () => {
    await openReview(preview({
      items: [],
      warnings: [{ code: 'IMPORT_SCRIPT_IGNORED', message: 'Collection scripts are ignored.' }],
      discoveredOrigins: [],
      affectedStates: [],
      summary: { valid: 0, invalid: 0, create: 0, merge: 0, skip: 0 },
    }));

    expect(screen.getByText('Collection scripts are ignored.')).toBeVisible();
    expect(screen.getByText('No importable requests were found.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import selected' })).toBeDisabled();
  });

  it('disables skip-only selection and counts previewed duplicate no-ops', async () => {
    const duplicate = item({
      id: 'duplicate-item',
      name: 'Existing duplicate',
      proposedAction: 'skip',
      allowedActions: ['merge', 'skip'],
      exactTargets: [{
        endpointId: 'endpoint-duplicate',
        endpointRevision: 4,
        name: 'Existing duplicate',
        newVariantCount: 0,
        candidateResponses: [],
      }],
      selectedByDefault: false,
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    const disabled = item({
      id: 'disabled-item',
      name: 'Disabled request',
      proposedAction: 'skip',
      allowedActions: ['skip'],
      selectedByDefault: false,
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    await openReview(preview({
      items: [item(), duplicate, disabled],
      summary: { valid: 2, invalid: 1, create: 1, merge: 0, skip: 2 },
    }));

    expect(screen.getByRole('checkbox', { name: 'Select Disabled request' })).toBeDisabled();
    expect(screen.getByTestId('skipped-duplicates-count')).toHaveTextContent('1');
  });

  it('renders dense public review data, filters, and redacted expandable details', async () => {
    const invalid = item({
      id: 'invalid-item',
      name: 'Invalid request',
      matcher: { method: 'TRACE', path: '/invalid' },
      locations: [{ type: 'curl', commandIndex: 1 }],
      breadcrumbs: [[]],
      warnings: [{ code: 'IMPORT_NOTE', message: 'Check this request.' }],
      errors: [{ code: 'IMPORT_METHOD_UNSUPPORTED', message: 'TRACE is unsupported.' }],
      selectedByDefault: false,
      proposedAction: 'skip',
      allowedActions: ['skip'],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    const create = item({
      locations: [
        { type: 'postman', itemPath: [0, 1] },
        { type: 'postman', itemPath: [2] },
      ],
      breadcrumbs: [['Users', 'Primary'], ['Archive']],
      warnings: [{ code: 'IMPORT_QUERY_IGNORED', message: 'Optional query matcher omitted.' }],
      requests: [item().requests[0]!, item().requests[0]!],
      responses: [{
        ...item().responses[0]!,
        responseHeaders: {
          'Content-Type': 'application/json',
          'Set-Cookie': [
            'session=unmistakable-response-cookie-secret; HttpOnly',
            'refresh=second-response-cookie-secret; Secure',
          ],
          'X-Api-Key': 'unmistakable-response-credential-secret',
        },
      }, {
        ...item().responses[0]!, name: 'Accepted', status: 202, identity: 'accepted-response',
      }],
    });
    const { user } = await openReview(preview({
      sourceType: 'postman',
      items: [create, invalid],
      warnings: [{ code: 'IMPORT_SCRIPT_IGNORED', message: 'Collection scripts are ignored.' }],
      summary: { valid: 1, invalid: 1, create: 1, merge: 0, skip: 1 },
    }));

    expect(screen.getByText('POST')).toBeVisible();
    expect(screen.getByText('https://api.example.test:8443/users')).toBeVisible();
    expect(screen.getByText('Users / Primary')).toBeVisible();
    expect(screen.getByText('Archive')).toBeVisible();
    expect(screen.getByText('2 responses')).toBeVisible();
    expect(screen.getByText('Optional query matcher omitted.')).toBeVisible();
    expect(screen.getByText('TRACE is unsupported.')).toBeVisible();
    for (const filter of ['Selected', 'Warnings', 'Errors', 'New', 'Merge']) {
      expect(screen.getByRole('button', { name: `Filter ${filter}` })).toBeVisible();
    }
    await user.click(screen.getByRole('button', { name: 'Filter Errors' }));
    expect(screen.getByText('Invalid request')).toBeVisible();
    expect(screen.queryByText('Create users')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filter Errors' }));
    await user.click(screen.getByRole('button', { name: 'Show details for Create users' }));

    expect(screen.getAllByText('[REDACTED]').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Authorization:/)[0]).toBeVisible();
    expect(screen.getByText('Created, status 201, 12 bytes')).toBeVisible();
    expect(screen.getByText(/Set-Cookie:/i)).toBeVisible();
    expect(screen.getByText(/X-Api-Key:/i)).toBeVisible();
    expect(screen.queryByText(/super-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unmistakable-response-cookie-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/second-response-cookie-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unmistakable-response-credential-secret/)).not.toBeInTheDocument();
  });

  it('reviews normalized origin and every query occurrence with the hidden-value warning', async () => {
    const { user } = await openReview(preview({
      discoveredOrigins: ['https://api.example.test:8443'],
      items: [item({
        baseUrl: 'https://api.example.test:8443',
        matcher: {
          method: 'POST',
          path: '/users',
          query: {
            access_token: [
              { operator: 'equals', value: 'first-secret' },
              { operator: 'equals', value: 'second-secret' },
            ],
            page: [
              { operator: 'equals', value: '2' },
              { operator: 'equals', value: '2' },
            ],
          },
        },
        requests: [{
          scheme: 'https',
          hostname: 'api.example.test',
          port: '8443',
          query: [
            { name: 'access_token', value: '[REDACTED]' },
            { name: 'access_token', value: '[REDACTED]' },
            { name: 'page', value: '2' },
            { name: 'page', value: '2' },
          ],
          headers: [],
        }],
      })],
    }));

    expect(screen.getByText('https://api.example.test:8443/users')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show details for Create users' }));
    expect(screen.getAllByText(/access_token:/)).toHaveLength(2);
    expect(screen.getAllByText(/page:/)).toHaveLength(2);
    expect(screen.getByText('Hidden query values will become local canonical matcher configuration.'))
      .toBeVisible();
    expect(screen.queryByText(/first-secret|second-secret/)).not.toBeInTheDocument();
  });

  it('gates commit on merge target selection and equal-specificity confirmation', async () => {
    const overlapping = item({
      overlaps: [{
        endpointId: 'overlap-1',
        baseUrl: 'https://api.example.test:8443',
        matcher: { method: 'POST', path: '/users' },
        relativeSpecificity: 'equal',
        confirmationRequired: true,
      }],
    });
    const merge = item({
      id: 'merge-item',
      name: 'Merge users',
      proposedAction: 'merge',
      allowedActions: ['merge', 'skip'],
      exactTargets: [{
        endpointId: 'endpoint-a', endpointRevision: 1, name: 'Users A', newVariantCount: 0,
        candidateResponses: [],
      }, {
        endpointId: 'endpoint-b', endpointRevision: 2, name: 'Users B', newVariantCount: 2,
        candidateResponses: [],
      }],
      overlaps: [],
      createEffect: { createsEndpoint: false, createsVariants: 0 },
    });
    const { user } = await openReview(preview({
      items: [overlapping, merge],
      summary: { valid: 2, invalid: 0, create: 1, merge: 1, skip: 0 },
    }));
    const commit = screen.getByRole('button', { name: 'Import selected' });
    expect(screen.getByText('Overlaps Endpoint overlap-1: POST https://api.example.test:8443/users (equal specificity)'))
      .toBeVisible();
    expect(commit).toBeDisabled();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Merge target for Merge users' }),
      'endpoint-a',
    );
    expect(screen.getByTestId('merged-variants-count')).toHaveTextContent('0');
    expect(commit).toBeDisabled();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Merge target for Merge users' }),
      'endpoint-b',
    );
    expect(screen.getByTestId('merged-variants-count')).toHaveTextContent('2');
    expect(commit).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Confirm overlap for Create users' }));
    expect(commit).toBeEnabled();
  });

  it('summarizes impact and explains matcher, interception, binding, and fallback behavior', async () => {
    await openReview(preview());

    expect(screen.getByTestId('selected-requests-count')).toHaveTextContent('1');
    expect(screen.getByTestId('new-endpoints-count')).toHaveTextContent('1');
    expect(screen.getByTestId('merged-variants-count')).toHaveTextContent('0');
    expect(screen.getByTestId('discovered-origins-count')).toHaveTextContent('1');
    expect(screen.getByTestId('skipped-duplicates-count')).toHaveTextContent('0');
    expect(screen.getByTestId('affected-states-count')).toHaveTextContent('1');
    expect(screen.getByText(/origins and query values become Endpoint matchers only/i)).toBeVisible();
    expect(screen.getByText(/interception settings are unchanged/i)).toBeVisible();
    expect(screen.getByText(/Endpoints remain unbound in existing App States/i)).toBeVisible();
    expect(screen.getByText(/fallback behavior remains available/i)).toBeVisible();
  });

  it('renders duplicate saved responses without duplicate React key warnings', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const duplicateResponse = item().responses[0]!;
    const duplicateWarning = { code: 'IMPORT_RESPONSE_HEADER_DISCARDED', message: 'Header discarded.' };
    const { user } = await openReview(preview({
      items: [item({
        responses: [duplicateResponse, { ...duplicateResponse, name: 'Created copy' }],
        warnings: [duplicateWarning, duplicateWarning],
      })],
    }));
    await user.click(screen.getByRole('button', { name: 'Show details for Create users' }));

    expect(consoleError.mock.calls.map(call => call.join(' ')).join('\n'))
      .not.toMatch(/same key|unique "key"/i);
  });

  it('locks controls and Modal dismissal for a pending commit', async () => {
    const pending = deferred<{
      createdEndpointIds: string[];
      updatedEndpointIds: string[];
      createdVariantIds: string[];
      skippedItemIds: string[];
    }>();
    vi.spyOn(importApi, 'commit').mockReturnValue(pending.promise);
    const wizardProps = props();
    const onSettlementChange = vi.fn();
    const { user } = await openReview(
      preview(),
      wizardProps,
      <ImportWizard {...wizardProps} {...{ onSettlementChange }} />,
    );

    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(onSettlementChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Create users' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Action for Create users' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Import API requests' }), { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-modal-backdrop]')!);
    expect(wizardProps.onRequestClose).not.toHaveBeenCalled();

    await act(async () => pending.resolve({
      createdEndpointIds: ['endpoint-1'], updatedEndpointIds: [],
      createdVariantIds: ['variant-1'], skippedItemIds: [],
    }));
    await waitFor(() => expect(onSettlementChange).toHaveBeenLastCalledWith(false));
  });

  it('publishes canonical data before showing complete counts and View Endpoints', async () => {
    vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1', 'endpoint-2'],
      updatedEndpointIds: ['endpoint-3'],
      createdVariantIds: ['variant-1', 'variant-2', 'variant-3'],
      skippedItemIds: ['skip-1'],
    });
    const canonicalRefresh = deferred<void>();
    const wizardProps = props({
      onCommitted: vi.fn(() => canonicalRefresh.promise),
      onDiscoveredOrigins: vi.fn(),
    });
    const { user } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    await waitFor(() => expect(wizardProps.onCommitted).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: 'Refreshing dashboard data' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The import was accepted. Refreshing canonical dashboard data before showing results.',
    );
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View Endpoints' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import selected' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeDisabled();
    expect(importApi.commit).toHaveBeenCalledTimes(1);

    await act(async () => canonicalRefresh.resolve());
    const completeHeading = await screen.findByRole('heading', { name: 'Import complete' });
    expect(completeHeading).toBeVisible();
    expect(completeHeading).toHaveFocus();
    expect(wizardProps.onCommitted).toHaveBeenCalledWith(expect.objectContaining({
      createdEndpointIds: ['endpoint-1', 'endpoint-2'],
    }));
    expect(wizardProps.onDiscoveredOrigins).toHaveBeenCalledWith(['https://api.example.test']);
    expect(screen.getByText('2 Endpoints created')).toBeVisible();
    expect(screen.getByText('1 Endpoint updated')).toBeVisible();
    expect(screen.getByText('3 Variants created')).toBeVisible();
    expect(screen.getByText('1 request skipped')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Review interception checklist' })).toBeVisible();
    expect(screen.getByText('https://api.example.test')).toBeVisible();
    expect(screen.getByText('Interception settings were not changed.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'View Endpoints' }));
    expect(wizardProps.onViewEndpoints).toHaveBeenCalledTimes(1);
  });

  it('discards a pending canonical refresh when switching Projects and returning', async () => {
    vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    });
    const canonicalRefresh = deferred<void>();
    const wizardProps = props({ onCommitted: vi.fn(() => canonicalRefresh.promise) });
    const { user, rerender } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(wizardProps.onCommitted).toHaveBeenCalledTimes(1));

    rerender(<ImportWizard {...wizardProps} projectId="project-2" />);
    rerender(<ImportWizard {...wizardProps} projectId="project-1" />);

    expectOnlySourceStep();
    await act(async () => canonicalRefresh.resolve());
    expectOnlySourceStep();
    expect(wizardProps.onCommitted).toHaveBeenCalledTimes(1);
  });

  it('blocks confirmed commit settlement at the synchronous Project boundary', async () => {
    const pendingCommit = deferred<{
      createdEndpointIds: string[];
      updatedEndpointIds: string[];
      createdVariantIds: string[];
      skippedItemIds: string[];
    }>();
    vi.spyOn(importApi, 'commit').mockReturnValue(pendingCommit.promise);
    const wizardProps = props();
    const switched = deferred<void>();
    const switchProject = { current: () => {} };
    const committed = {
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    };
    const { user } = await openReview(
      preview(),
      wizardProps,
      <ProjectSwitchRaceHarness
        wizardProps={wizardProps}
        switchProjectRef={switchProject}
        onProjectCommit={() => {
          pendingCommit.resolve(committed);
          switched.resolve();
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    // act flushes passive effects; preserve browser ordering to exercise the commit-boundary race.
    await runBeforePassiveEffects(async () => {
      switchProject.current();
      await switched.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(wizardProps.onCommitted).not.toHaveBeenCalled();
    expect(wizardProps.onCommitOutcomeUnknown).not.toHaveBeenCalled();
    await act(async () => {});
    expectOnlySourceStep();
  });

  it('blocks unknown commit settlement at the synchronous Project boundary', async () => {
    const pendingCommit = deferred<{
      createdEndpointIds: string[];
      updatedEndpointIds: string[];
      createdVariantIds: string[];
      skippedItemIds: string[];
    }>();
    vi.spyOn(importApi, 'commit').mockReturnValue(pendingCommit.promise);
    const wizardProps = props();
    const switched = deferred<void>();
    const switchProject = { current: () => {} };
    const { user } = await openReview(
      preview(),
      wizardProps,
      <ProjectSwitchRaceHarness
        wizardProps={wizardProps}
        switchProjectRef={switchProject}
        onProjectCommit={() => {
          pendingCommit.reject(new TypeError('response decode failed'));
          switched.resolve();
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    await runBeforePassiveEffects(async () => {
      switchProject.current();
      await switched.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(wizardProps.onCommitted).not.toHaveBeenCalled();
    expect(wizardProps.onCommitOutcomeUnknown).not.toHaveBeenCalled();
    await act(async () => {});
    expectOnlySourceStep();
  });

  it('does not restore succeeded settlement after switching Projects and returning', async () => {
    vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    });
    const wizardProps = props();
    const { user, rerender } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeVisible();

    rerender(<ImportWizard {...wizardProps} projectId="project-2" />);
    rerender(<ImportWizard {...wizardProps} projectId="project-1" />);

    expectOnlySourceStep();
  });

  it('shows an honest canonical refresh failure and retries only the refresh callback', async () => {
    vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    });
    const firstRefresh = deferred<void>();
    const retryRefresh = deferred<void>();
    const onCommitted = vi.fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => retryRefresh.promise);
    const wizardProps = props({ onCommitted });
    const { user } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));

    await act(async () => firstRefresh.reject(new Error('canonical read failed')));

    expect(await screen.findByRole('heading', { name: 'Dashboard refresh failed' })).toBeVisible();
    expect(screen.getByText(
      'The import was accepted, but the dashboard could not refresh canonical data. Do not import again.',
    )).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
    expect(screen.queryByText(/dashboard now reflects the canonical import result/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View Endpoints' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeEnabled();
    expect(importApi.commit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Retry dashboard refresh' }));

    expect(await screen.findByRole('heading', { name: 'Refreshing dashboard data' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeDisabled();
    expect(onCommitted).toHaveBeenCalledTimes(2);
    expect(importApi.commit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry dashboard refresh' })).not.toBeInTheDocument();

    await act(async () => retryRefresh.resolve());
    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'View Endpoints' })).toBeVisible();
    expect(importApi.commit).toHaveBeenCalledTimes(1);
  });

  it('does not restore failed settlement after switching Projects and returning', async () => {
    vi.spyOn(importApi, 'commit').mockResolvedValue({
      createdEndpointIds: ['endpoint-1'],
      updatedEndpointIds: [],
      createdVariantIds: ['variant-1'],
      skippedItemIds: [],
    });
    const wizardProps = props({
      onCommitted: vi.fn().mockRejectedValue(new Error('canonical read failed')),
    });
    const { user, rerender } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard refresh failed' })).toBeVisible();

    rerender(<ImportWizard {...wizardProps} projectId="project-2" />);
    rerender(<ImportWizard {...wizardProps} projectId="project-1" />);

    expectOnlySourceStep();
  });

  it('refreshes canonical data before publishing an unknown commit outcome', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new TypeError('response decode failed'));
    const refresh = deferred<void>();
    const wizardProps = props({ onCommitOutcomeUnknown: vi.fn(() => refresh.promise) });
    const { user } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    await waitFor(() => expect(wizardProps.onCommitOutcomeUnknown).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Create users' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Import API requests' }), { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-modal-backdrop]')!);
    expect(wizardProps.onRequestClose).not.toHaveBeenCalled();
    await act(async () => refresh.resolve());
    expect(await screen.findByText(/outcome is unknown/i)).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Import selected' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Create users' })).toBeDisabled();
  });

  it('discards a pending unknown-outcome refresh when switching Projects and returning', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new TypeError('response decode failed'));
    const refresh = deferred<void>();
    const wizardProps = props({ onCommitOutcomeUnknown: vi.fn(() => refresh.promise) });
    const { user, rerender } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(wizardProps.onCommitOutcomeUnknown).toHaveBeenCalledTimes(1));

    rerender(<ImportWizard {...wizardProps} projectId="project-2" />);
    rerender(<ImportWizard {...wizardProps} projectId="project-1" />);

    expectOnlySourceStep();
    await act(async () => refresh.resolve());
    expectOnlySourceStep();
    expect(wizardProps.onCommitOutcomeUnknown).toHaveBeenCalledTimes(1);
  });

  it('uses neutral copy when the unknown-outcome canonical refresh also fails', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new TypeError('response decode failed'));
    const wizardProps = props({
      onCommitOutcomeUnknown: vi.fn().mockRejectedValue(new Error('canonical read failed')),
    });
    const { user } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    const alert = await screen.findByText(
      'The import outcome is unknown, and the dashboard could not refresh canonical data. Check Endpoints before trying again.',
    );
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/Canonical data was refreshed before showing this message/i)).not.toBeInTheDocument();
    expect(wizardProps.onCommitOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(importApi.commit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Import selected' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeEnabled();
  });

  it('keeps stale review data visible and prevents repeated refreshes while refreshing', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new ApiClientError(
      409,
      'IMPORT_PREVIEW_STALE',
      'Preview is stale',
      'request-1',
    ));
    const { user } = await openReview(preview());
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(await screen.findByText(/preview is stale/i)).toHaveAttribute('role', 'alert');

    const refreshed = deferred<ImportPreview>();
    vi.mocked(importApi.preview).mockReturnValueOnce(refreshed.promise);
    await user.click(screen.getByRole('button', { name: 'Refresh preview' }));

    const refreshing = screen.getByRole('button', { name: 'Refreshing preview...' });
    expect(refreshing).toBeDisabled();
    expect(screen.getByText('Create users')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Create users' })).toBeDisabled();
    await user.click(refreshing);
    expect(importApi.preview).toHaveBeenCalledTimes(2);

    await act(async () => refreshed.resolve(preview({
      snapshotToken: 'snapshot-2',
      items: [item({ name: 'Create users refreshed' })],
    })));
    expect(await screen.findByText('Create users refreshed')).toBeVisible();
    expect(screen.queryByText(/preview is stale/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh preview' })).not.toBeInTheDocument();
  });

  it('keeps the stale warning visible alongside a specific refresh failure', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new ApiClientError(
      409,
      'IMPORT_PREVIEW_STALE',
      'Preview is stale',
      'request-1',
    ));
    const { user } = await openReview(preview());
    await user.click(screen.getByRole('button', { name: 'Import selected' }));
    vi.mocked(importApi.preview).mockRejectedValueOnce(new Error('Canonical preview refresh failed'));

    await user.click(screen.getByRole('button', { name: 'Refresh preview' }));

    expect(await screen.findByText('Canonical preview refresh failed')).toHaveAttribute('role', 'alert');
    expect(screen.getByText(/This preview is stale/i)).toHaveAttribute('role', 'alert');
  });

  it('does not run ambiguous-outcome refresh for documented API failures', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new ApiClientError(
      422,
      'IMPORT_SELECTION_INVALID',
      'Select a valid action.',
      'request-1',
    ));
    const wizardProps = props();
    const { user } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    expect(await screen.findByText('Select a valid action.')).toHaveAttribute('role', 'alert');
    expect(wizardProps.onCommitOutcomeUnknown).not.toHaveBeenCalled();
  });

  it('runs ambiguous-outcome refresh for a commit 5xx response', async () => {
    vi.spyOn(importApi, 'commit').mockRejectedValue(new ApiClientError(
      503,
      'INTERNAL_ERROR',
      'Unavailable',
      'request-1',
    ));
    const wizardProps = props();
    const { user } = await openReview(preview(), wizardProps);
    await user.click(screen.getByRole('button', { name: 'Import selected' }));

    await waitFor(() => expect(wizardProps.onCommitOutcomeUnknown).toHaveBeenCalledOnce());
    expect(await screen.findByText(/outcome is unknown/i)).toHaveAttribute('role', 'alert');
  });
});
