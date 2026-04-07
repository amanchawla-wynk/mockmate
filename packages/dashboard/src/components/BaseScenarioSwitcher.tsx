/**
 * BaseScenarioSwitcher component - dropdown to switch project's baseScenario
 */

import { useEffect, useRef, useState } from 'react';
import { projectsApi } from '../api/client';
import type { Resource } from '../api/types';

interface BaseScenarioSwitcherProps {
  projectId: string;
  resources: Resource[];
  baseScenario: string;
  onSwitch: () => void;
}

export function BaseScenarioSwitcher({
  projectId,
  resources,
  baseScenario,
  onSwitch,
}: BaseScenarioSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const allScenarios = Array.from(
    new Set(resources.flatMap(r => r.scenarios.map(s => s.name)))
  ).sort((a, b) => {
    if (a === 'default') return -1;
    if (b === 'default') return 1;
    return a.localeCompare(b);
  });

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSwitch = async (scenarioName: string) => {
    if (scenarioName === baseScenario) {
      setIsOpen(false);
      return;
    }

    try {
      setSwitching(true);
      setError(null);
      await projectsApi.update(projectId, { baseScenario: scenarioName });
      setIsOpen(false);
      onSwitch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch base scenario');
    } finally {
      setSwitching(false);
    }
  };

  if (allScenarios.length === 0) {
    return null;
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={switching}
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
        <span className="font-medium text-gray-700">
          {switching ? 'Switching...' : baseScenario}
        </span>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
            <p className="text-xs font-medium text-gray-700 uppercase tracking-wide">Switch Base Scenario</p>
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-50 border-b border-red-200">
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}

          <div className="max-h-80 overflow-y-auto">
            {allScenarios.map((scenarioName) => {
              const isActive = scenarioName === baseScenario;
              const isDefault = scenarioName === 'default';
              const resourceCount = resources.filter(r => r.scenarios.some(s => s.name === scenarioName)).length;

              return (
                <button
                  key={scenarioName}
                  onClick={() => handleSwitch(scenarioName)}
                  disabled={switching}
                  className={
                    `w-full px-3 py-2.5 text-left flex items-center justify-between transition-colors ` +
                    (isActive ? 'bg-blue-50 text-blue-900' : 'text-gray-700 hover:bg-gray-50') +
                    (switching ? ' opacity-50 cursor-not-allowed' : '')
                  }
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{scenarioName}</span>
                      {isDefault && (
                        <span className="flex-shrink-0 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Default</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {resourceCount} {resourceCount === 1 ? 'resource' : 'resources'}
                    </p>
                  </div>

                  {isActive && (
                    <svg className="w-5 h-5 text-blue-600 flex-shrink-0 ml-2" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          <div className="px-3 py-2 border-t border-gray-200 bg-gray-50">
            <p className="text-xs text-gray-500">
              Base scenario is used as a fallback when a rule doesn’t define the active scenario.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
