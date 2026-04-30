/**
 * SymbolDetail: Shows callers, callees, and symbol metadata
 */

import { Loader2 } from 'lucide-react';
import type { ProcessSymbol, ContextResponse } from '../types/gitnexus-api';

interface SymbolDetailProps {
  symbol: ProcessSymbol;
  context: ContextResponse | null;
  loading: boolean;
}

export default function SymbolDetail({ symbol, context, loading }: SymbolDetailProps) {
  return (
    <div className="border-border border-b p-4">
      <div className="bg-surface2 mb-4 rounded p-3">
        <div className="text-text2 text-xs font-semibold tracking-wide uppercase">
          Selected Symbol
        </div>
        <div className="text-text mt-2 font-mono text-sm">{symbol.name}</div>
        <div className="text-text2 mt-1 text-xs">{symbol.type}</div>
        <div className="text-text2 mt-1 font-mono text-[10px]">
          {symbol.file}:{symbol.line}
        </div>
        {symbol.module && <div className="text-text2 mt-1 text-xs">Module: {symbol.module}</div>}
        {symbol.description && <div className="text-text2 mt-2 text-xs">{symbol.description}</div>}
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span className="text-text2 text-xs">Loading context...</span>
        </div>
      ) : context ? (
        <div className="space-y-4">
          {/* Callers */}
          {context.callers && context.callers.length > 0 && (
            <div>
              <h5 className="text-text2 mb-2 text-xs font-semibold tracking-wide uppercase">
                Callers ({context.callers.length})
              </h5>
              <div className="space-y-1">
                {context.callers.map((caller, i) => (
                  <div key={i} className="text-xs">
                    <div className="flex items-center gap-1">
                      <span className="text-text2">←</span>
                      <span className="text-text font-mono">{caller.name}</span>
                      {caller.count && <span className="text-text2">×{caller.count}</span>}
                    </div>
                    <div className="text-text2 ml-5 text-[10px]">
                      {caller.type} • {caller.file.split('/').pop()}:{caller.line}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Callees */}
          {context.callees && context.callees.length > 0 && (
            <div>
              <h5 className="text-text2 mb-2 text-xs font-semibold tracking-wide uppercase">
                Callees ({context.callees.length})
              </h5>
              <div className="space-y-1">
                {context.callees.map((callee, i) => (
                  <div key={i} className="text-xs">
                    <div className="flex items-center gap-1">
                      <span className="text-text2">→</span>
                      <span className="text-text font-mono">{callee.name}</span>
                      {callee.count && <span className="text-text2">×{callee.count}</span>}
                    </div>
                    <div className="text-text2 ml-5 text-[10px]">
                      {callee.type} • {callee.file.split('/').pop()}:{callee.line}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Member of */}
          {context.member_of && context.member_of.length > 0 && (
            <div>
              <h5 className="text-text2 mb-2 text-xs font-semibold tracking-wide uppercase">
                Member Of ({context.member_of.length})
              </h5>
              <div className="space-y-1">
                {context.member_of.map((mem, i) => (
                  <div key={i} className="text-xs">
                    <span className="text-text font-mono">{mem.name}</span>
                    <span className="text-text2 ml-2">({mem.type})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Implements */}
          {context.implements && context.implements.length > 0 && (
            <div>
              <h5 className="text-text2 mb-2 text-xs font-semibold tracking-wide uppercase">
                Implements ({context.implements.length})
              </h5>
              <div className="space-y-1">
                {context.implements.map((impl, i) => (
                  <div key={i} className="text-text font-mono text-xs">
                    {impl.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Extends */}
          {context.extends && context.extends.length > 0 && (
            <div>
              <h5 className="text-text2 mb-2 text-xs font-semibold tracking-wide uppercase">
                Extends ({context.extends.length})
              </h5>
              <div className="space-y-1">
                {context.extends.map((ext, i) => (
                  <div key={i} className="text-text font-mono text-xs">
                    {ext.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Related */}
          {context.related && context.related.length > 0 && (
            <div>
              <h5 className="text-text2 mb-2 text-xs font-semibold tracking-wide uppercase">
                Related ({context.related.length})
              </h5>
              <div className="space-y-1">
                {context.related.map((rel, i) => (
                  <div key={i} className="text-xs">
                    <div className="text-text font-mono">{rel.name}</div>
                    <div className="text-text2 text-[10px]">{rel.type}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No context found */}
          {!context.callers?.length &&
            !context.callees?.length &&
            !context.member_of?.length &&
            !context.implements?.length &&
            !context.extends?.length &&
            !context.related?.length && (
              <div className="py-4 text-center">
                <p className="text-text2 text-xs">No additional context found</p>
              </div>
            )}
        </div>
      ) : (
        <div className="py-4 text-center">
          <p className="text-text2 text-xs">No context available</p>
        </div>
      )}
    </div>
  );
}
