import { useState } from 'react';
import type { CreateProjectInput } from '../api/types';

interface ProjectModalProps {
  isOpen: boolean;
  onClose(): void;
  onSubmit(data: CreateProjectInput): Promise<void>;
}

export function ProjectModal({ isOpen, onClose, onSubmit }: ProjectModalProps) {
  if (!isOpen) return null;
  return <ProjectModalContent onClose={onClose} onSubmit={onSubmit} />;
}

function ProjectModalContent({ onClose, onSubmit }: Omit<ProjectModalProps, 'isOpen'>) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await onSubmit({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create Project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-label="Create Project" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={submit} className="w-full max-w-lg space-y-4 rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900">Create Project</h2>
        {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
        <label className="block text-sm font-medium text-gray-700">
          Project Name
          <input aria-label="Project Name" autoFocus required value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Description
          <textarea value={description} onChange={event => setDescription(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" rows={3} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="rounded border border-gray-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? 'Creating...' : 'Create Project'}</button>
        </div>
      </form>
    </div>
  );
}
