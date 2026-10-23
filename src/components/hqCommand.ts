import { getState, sendCommand, useSync } from '../lib/db.ts';
import { applyCommand, type Command, type CommandContext } from '../lib/commands.ts';
import type { Store } from '../lib/types.ts';

/**
 * HQ sends one command: checked here first against this device's view, like the server will,
 * then queued in the outbox. `make` gets the store as it is right now (a command's `base` is the
 * version it sees). Returns '' on success, or what went wrong, in words for the page.
 */
export function useHqCommand() {
  const sync = useSync();
  return (storeId: string, make: (store: Store) => Command): string => {
    const state = getState();
    const store = state.stores[storeId];
    const event = store && state.events[store.eventId];
    if (!store || !event) return 'That store isn’t loaded on this device.';
    const cmd = make(store);
    const ctx: CommandContext = { commandId: 'hq-precheck', now: new Date().toISOString(), actor: { principal: sync.principal ?? 'super', name: sync.name ?? 'HQ', role: 'super' }, event };
    try {
      applyCommand(store, cmd, ctx);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    try {
      sendCommand(storeId, cmd);
    } catch (e) {
      return `Couldn’t queue this on the device: ${(e as Error).message}`;
    }
    return '';
  };
}
