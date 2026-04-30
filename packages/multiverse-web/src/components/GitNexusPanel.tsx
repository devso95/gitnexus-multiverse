/**
 * GitNexusPanel: Right sidebar showing code intelligence
 * Displays processes, symbols, and symbol context
 */

import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, Code2 } from 'lucide-react';
import { useGitNexus } from '../hooks/useGitNexus';
import type { ProcessSymbol, ContextResponse, QueryResponse } from '../types/gitnexus-api';
import SymbolDetail from './SymbolDetail';

interface GitNexusPanelProps {
  serviceId: string;
  repoId?: string;
  onError?: (error: Error) => void;
}

export default function GitNexusPanel({ serviceId, repoId, onError }: GitNexusPanelProps) {
  const { query, context, isAvailable, error } = useGitNexus();

  const [symbols, setSymbols] = useState<ProcessSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<ProcessSymbol | null>(null);
  const [symbolContext, setSymbolContext] = useState<ContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);

  const derivedRepoId = repoId || serviceId;

  // Fetch initial symbols
  useEffect(() => {
    if (!isAvailable || !derivedRepoId) return;

    setLoading(true);
    setSymbols([]);

    query(derivedRepoId, `overview symbols processes in ${derivedRepoId}`, {
      limit: 10,
      service: serviceId,
    })
      .then((resp: QueryResponse) => {
        setSymbols(resp.process_symbols || []);
      })
      .catch((err) => {
        onError?.(err);
      })
      .finally(() => setLoading(false));
  }, [derivedRepoId, isAvailable, query, onError, serviceId]);

  // Fetch symbol context when selected
  useEffect(() => {
    if (!selectedSymbol || !isAvailable) return;

    setContextLoading(true);

    context(derivedRepoId, selectedSymbol.name, serviceId)
      .then(setSymbolContext)
      .catch((err) => {
        onError?.(err);
        setSymbolContext(null);
      })
      .finally(() => setContextLoading(false));
  }, [selectedSymbol, derivedRepoId, isAvailable, context, onError, serviceId]);

  if (!isAvailable) {
    return (
      <div className="border-border w-96 shrink-0 border-l bg-surface p-6 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-amber-400" />
        <h3 className="mb-2 font-semibold text-amber-400">GitNexus Not Available</h3>
        <p className="text-text2 text-sm">
          Code intelligence requires GitNexus API at{' '}
          {import.meta.env.VITE_GITNEXUS_API || 'http://localhost:4747'}
        </p>
        <p className="text-text2 mt-4 text-xs">
          Start with: <code className="bg-surface2 rounded px-2 py-1">npx gitnexus serve</code>
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-border w-96 shrink-0 border-l bg-surface p-6 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
        <h3 className="mb-2 font-semibold text-red-400">GitNexus Error</h3>
        <p className="text-text2 text-sm">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="border-border flex w-96 shrink-0 flex-col border-l bg-surface">
      {/* Header */}
      <div className="border-border border-b p-4">
        <div className="mb-1 flex items-center gap-2">
          <Code2 className="h-4 w-4 text-accent" />
          <h3 className="text-text2 text-xs font-semibold tracking-wide uppercase">
            Code Intelligence
          </h3>
        </div>
        <p className="text-text2 text-xs">
          {isAvailable ? 'Powered by GitNexus' : 'GitNexus integration disabled'}
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            <span className="text-text2 text-sm">Loading symbols...</span>
          </div>
        ) : symbols.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-text2 text-sm">
              No symbols found for {serviceId}.
              <br />
              Ensure the repository is indexed with{' '}
              <code className="bg-surface2 rounded px-2 py-1 text-xs">gitnexus analyze</code>
            </p>
          </div>
        ) : (
          <div className="divide-border divide-y">
            {/* Symbols list */}
            <div>
              <h4 className="border-border bg-surface2 text-text2 border-b px-4 py-2 text-xs font-semibold tracking-wide uppercase">
                Symbols ({symbols.length})
              </h4>
              <div className="divide-border divide-y">
                {symbols.map((sym) => (
                  <button
                    key={`${sym.file}:${sym.line}`}
                    onClick={() => setSelectedSymbol(sym)}
                    className={`w-full px-4 py-3 text-left transition-colors hover:bg-accent/5 ${
                      selectedSymbol?.name === sym.name
                        ? 'border-l-2 border-accent bg-accent/10'
                        : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-text font-mono text-sm">{sym.name}</div>
                        <div className="text-text2 text-xs">{sym.type}</div>
                      </div>
                      <div className="text-text2 text-[10px] whitespace-nowrap">
                        {sym.file.split('/').pop()}:{sym.line}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Symbol detail */}
            {selectedSymbol && (
              <SymbolDetail
                symbol={selectedSymbol}
                context={symbolContext}
                loading={contextLoading}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
