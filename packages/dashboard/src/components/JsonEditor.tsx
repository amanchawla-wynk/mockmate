/**
 * JsonEditor component - simple JSON editor with validation
 */

import { useState, useEffect } from 'react';

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  onValidate?: (isValid: boolean, error?: string) => void;
  placeholder?: string;
  minHeight?: string;
}

export function JsonEditor({
  value,
  onChange,
  error: externalError,
  onValidate,
  placeholder = '{\n  "key": "value"\n}',
  minHeight = '200px',
}: JsonEditorProps) {
  const [internalError, setInternalError] = useState<string | null>(null);

  useEffect(() => {
    validateJson(value);
  }, [value]);

  const validateJson = (jsonString: string) => {
    if (!jsonString.trim()) {
      setInternalError(null);
      onValidate?.(true);
      return;
    }

    try {
      JSON.parse(jsonString);
      setInternalError(null);
      onValidate?.(true);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Invalid JSON';
      setInternalError(error);
      onValidate?.(false, error);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(value);
      const formatted = JSON.stringify(parsed, null, 2);
      onChange(formatted);
    } catch (err) {
      // Don't format if invalid
    }
  };

  const displayError = externalError || internalError;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium text-gray-700">
          Response Body (JSON)
        </label>
        <button
          type="button"
          onClick={formatJson}
          disabled={!!internalError}
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          Format JSON
        </button>
      </div>

      <textarea
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className={`
          w-full px-3 py-2 font-mono text-sm border rounded-md
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
          resize-vertical
          ${displayError
            ? 'border-red-300 bg-red-50'
            : 'border-gray-300 bg-white'
          }
        `}
        style={{ minHeight }}
        spellCheck={false}
      />

      {displayError && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          <span className="font-medium">JSON Error:</span> {displayError}
        </div>
      )}

      <p className="mt-1 text-xs text-gray-500">
        Enter valid JSON. Leave empty for no response body.
      </p>
    </div>
  );
}
