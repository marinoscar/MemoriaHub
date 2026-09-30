/**
 * THE iOS "ADD TO HOME SCREEN" WALKTHROUGH — issue #486, epic #481 (ported
 * from EnterpriseAppBase).
 *
 * Rendered by `NotificationSettings.tsx` whenever `useNotificationCapability`
 * reports `'ios-needs-install'`. iOS/iPadOS allow web notifications only for an
 * app added to the Home Screen, and the remedy has two concrete steps with a
 * specific icon and a specific menu-item title, so it reads better as a short
 * list than as a sentence.
 *
 * WHY THE COPY IS THIS SPECIFIC. "Tap the Share button" is useless on its own:
 * Safari's toolbar never spells "Share" out, so the copy describes the icon (a
 * square with an arrow pointing up) and names the menu item exactly as Safari
 * labels it — "Add to Home Screen".
 *
 * DELIBERATELY DUMB: no props and no platform detection. The one place that
 * decides whether this applies is `resolveNotificationCapability`; a second
 * gate here would be a second place that could disagree with it.
 */

import { Alert, AlertTitle, List, ListItem, ListItemIcon, ListItemText, Typography } from '@mui/material';
import IosShareIcon from '@mui/icons-material/IosShare';
import AddToHomeScreenIcon from '@mui/icons-material/AddToHomeScreen';

export function AddToHomeScreenPanel() {
  return (
    <Alert severity="info">
      <AlertTitle>Add this app to your Home Screen</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        iOS and iPadOS permit web notifications only for an app added to the
        Home Screen — never for a page open in an ordinary Safari tab, no
        matter what permission you grant there. Add it once, then open the app
        from its Home Screen icon to turn notifications on.
      </Typography>

      <List dense disablePadding>
        <ListItem disableGutters alignItems="flex-start">
          <ListItemIcon sx={{ minWidth: 32, mt: '2px' }}>
            <IosShareIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="1. Tap the Share button"
            secondary={
              // The square-with-an-upward-arrow icon, not a labelled "Share"
              // button — Safari's toolbar never spells the word out.
              "The square icon with an arrow pointing up, in Safari's toolbar."
            }
          />
        </ListItem>
        <ListItem disableGutters alignItems="flex-start">
          <ListItemIcon sx={{ minWidth: 32, mt: '2px' }}>
            <AddToHomeScreenIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary='2. Choose "Add to Home Screen"'
            secondary="It's further down the share sheet's list of actions."
          />
        </ListItem>
      </List>

      <Typography variant="body2" sx={{ mt: 1 }}>
        Then open the app from that new Home Screen icon — not from Safari —
        and allow notifications when it asks.
      </Typography>
    </Alert>
  );
}

export default AddToHomeScreenPanel;
