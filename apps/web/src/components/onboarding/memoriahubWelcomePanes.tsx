/**
 * MemoriaHub's welcome panes for the platform `WelcomeDialog` (RETRO-H3, #599).
 *
 * The packaged dialog owns the chrome (title, "Later" and the primary button, the routing to the
 * Setup guide or Get started, the "seen" write on every way out, focus and Escape). These are the two
 * BODIES it takes through `slots.userPane` and `slots.adminPane`: one short pane each, naming the four
 * things the library is for (upload, circles, people, memories), then what the checklist does.
 *
 * Copy is data (`WELCOME_PANES`) so the tests assert the claims, not the markup. No breakpoint is read
 * here: the dialog is sized by the platform (the five coupled breakpoint gates are fixed).
 */
import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { WelcomePaneProps } from '@marinoscar/platform-web/onboarding/ui';

export type WelcomeAudience = 'user' | 'admin';

export interface WelcomePaneCopy {
  lead: string;
  points: readonly string[];
  closing: string;
}

/** What the library is for, in the order a new user meets it. */
export const WELCOME_POINTS = [
  'Upload your photos and videos, from the browser or automatically from your phone.',
  'Share them in circles with the people they belong to.',
  'Find everyone in them: name a face once and every photo of that person follows.',
  'Get memories back: On This Day, trips and the people in them, on Home.',
] as const;

export const WELCOME_PANES: Record<WelcomeAudience, WelcomePaneCopy> = {
  user: {
    lead: 'A private home for your family’s photos and videos.',
    points: WELCOME_POINTS,
    closing:
      'A short checklist tracks your first steps. Nothing on it stops you looking around first, and it stays in Settings → Getting started.',
  },
  admin: {
    lead: 'A private home for your family’s photos and videos, on a deployment you run.',
    points: WELCOME_POINTS,
    closing:
      'Storage, email, face recognition, tagging and memories all start switched off. The setup guide checks each one against the live deployment and links to the page that turns it on.',
  },
};

function Pane({ audience, descriptionId }: { audience: WelcomeAudience; descriptionId: string }): ReactElement {
  const copy = WELCOME_PANES[audience];
  return (
    <Box id={descriptionId}>
      <Typography sx={{ mb: 1.5 }}>{copy.lead}</Typography>
      <Box component="ul" sx={{ pl: 3, my: 0 }}>
        {copy.points.map((point) => (
          <Typography component="li" key={point} variant="body2" sx={{ mb: 0.75 }}>
            {point}
          </Typography>
        ))}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        {copy.closing}
      </Typography>
    </Box>
  );
}

export const userWelcomePane = ({ descriptionId }: WelcomePaneProps) => (
  <Pane audience="user" descriptionId={descriptionId} />
);

export const adminWelcomePane = ({ descriptionId }: WelcomePaneProps) => (
  <Pane audience="admin" descriptionId={descriptionId} />
);
