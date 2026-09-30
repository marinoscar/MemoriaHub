import { useCallback } from 'react';
import { Button, IconButton, Snackbar } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * The "a new version is available" prompt, and the thing that REGISTERS the
 * service worker at all.
 *
 * Issue #482, epic #481 (ported from the EnterpriseAppBase template). The
 * worker is built with `registerType: 'prompt'` (`pwa/service-worker.ts`): a
 * new worker installs, moves to `waiting`, and stays there. Because it
 * PRECACHES THE APP SHELL, the browser keeps serving the shell of whichever
 * revision installed first — so without this component a deploy would reach
 * nobody until every tab of the origin closed. This surfaces the waiting
 * worker and posts the `SKIP_WAITING` message `src/sw.ts` listens for.
 *
 * WHY NOT `registerType: 'autoUpdate'`: it reloads the page underneath the
 * user the moment a new worker installs, discarding unsaved work — an album
 * rename, a workflow being built, an admin settings form — mid-keystroke, for
 * a deploy the user had no part in. `prompt` costs one click and makes the
 * reload the user's decision.
 *
 * THIS COMPONENT OWNS REGISTRATION: `useRegisterSW` registers the worker,
 * which is why `pwa/service-worker.ts` sets `injectRegister: null`. It is
 * mounted in `App.tsx` outside `<Routes>`, so it runs on every route including
 * `/login` and public share pages.
 *
 * IT RENDERS NOTHING IN THE DEFAULT STATE — `null`, not a hidden Snackbar —
 * so a normal page load is identical to one without it. The one unprompted
 * appearance is the very first visit in a browser profile, where
 * `offlineReady` fires as the worker installs and shows a brief confirmation.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  const dismiss = useCallback(() => {
    setNeedRefresh(false);
    setOfflineReady(false);
  }, [setNeedRefresh, setOfflineReady]);

  const reload = useCallback(() => {
    // This posts `SKIP_WAITING` to the waiting worker; `src/sw.ts` answers it
    // with `self.skipWaiting()`, and the hook's own `controlling` listener
    // reloads the page once the new worker has taken over. Not awaited: the
    // document is replaced out from under the promise.
    //
    // The `true` is the documented "reload the page" argument, kept because it
    // states the intent at the call site — but note that vite-plugin-pwa has
    // IGNORED this parameter since 0.13.2 (it is `_reloadPage` in the source).
    // The reload is wired by the hook regardless, so do not read this argument
    // as the thing that causes it.
    void updateServiceWorker(true);
  }, [updateServiceWorker]);

  // The update always wins if both are somehow true: "there is a newer version
  // of this app" is actionable, "the shell is cached" is a note.
  if (!needRefresh && !offlineReady) {
    return null;
  }

  return (
    <Snackbar
      open
      // The update prompt does NOT auto-hide: it is the only route by which an
      // update reaches a long-lived tab, and a message that vanishes after five
      // seconds is one the user is entitled to miss. The offline confirmation
      // does auto-hide — it is an FYI about something that already succeeded.
      autoHideDuration={needRefresh ? null : 4000}
      onClose={(_event, reason) => {
        // Click-away must not dismiss the update prompt; the user is expected
        // to keep working in the page behind it and decide when to reload.
        if (reason === 'clickaway') return;
        dismiss();
      }}
      message={
        needRefresh ? 'A new version is available' : 'Ready to work offline'
      }
      // Clears the fixed `BottomNav`, which exists only below `sm` — the same
      // breakpoint `<main>`'s `pb: { xs: 10, sm: 3 }` in `Layout.tsx` clears it
      // at. This is a static responsive STYLE, not another `useMediaQuery`
      // mount gate, so it changes nothing about what is in the tree.
      sx={{ bottom: { xs: 72, sm: 24 } }}
      action={
        <>
          {needRefresh && (
            <Button color="secondary" size="small" onClick={reload}>
              Reload
            </Button>
          )}
          <IconButton
            size="small"
            aria-label="Dismiss update notice"
            color="inherit"
            onClick={dismiss}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </>
      }
    />
  );
}

export default UpdatePrompt;
