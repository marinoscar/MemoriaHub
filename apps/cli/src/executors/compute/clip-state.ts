/** Counters of the CLIP session, kept apart from the compute module so reading them loads nothing. */
export const clipStats = { embeds: 0, recycles: 0, sessionEmbeds: 0 };

/** The executor's heartbeat vitals (`^[a-z][a-z0-9_.]{1,47}$` keys, finite numbers). */
export function clipVitals(): Record<string, number> {
  return {
    'clip.embeds': clipStats.embeds,
    'clip.session.embeds': clipStats.sessionEmbeds,
    'clip.session.recycles': clipStats.recycles,
  };
}
