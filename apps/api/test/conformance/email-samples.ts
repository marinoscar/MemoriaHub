// Sample data for the `email` conformance suite (RETRO-D2, #570): one per app
// template, with markup in every free-text field so the suite's escaping check
// has something to catch.

const HOSTILE = '<b>Circle Alpha</b>';

export const EMAIL_TEMPLATE_SAMPLES: Readonly<Record<string, unknown>> = {
  'circle-invitation': {
    circleName: HOSTILE,
    inviterName: '<i>Person A</i>',
    acceptUrl: 'https://app.example.test/activate?returnTo=%2Fcircles%2Fc1',
    declineUrl: 'https://app.example.test/decline',
    recipientEmail: 'person-b@example.test',
  },
  'membership-confirmation': {
    circleName: HOSTILE,
    circleDescription: '<script>x</script>',
    role: 'collaborator',
    viewUrl: 'https://app.example.test/circles/c1',
  },
  'memory-digest': {
    circleName: HOSTILE,
    recipientName: '<i>Person A</i>',
    memories: [
      {
        id: 'm1',
        type: 'on_this_day',
        typeLabel: 'On this day',
        title: '<u>A day</u>',
        subtitle: '<s>2019</s>',
        narrative: '<em>narrative</em>',
        itemCount: 4,
        imageUrl: 'https://app.example.test/api/public/memories/digest-image/tok',
        url: 'https://app.example.test/memories/m1',
      },
      { id: 'm2', type: 'trip', typeLabel: 'Trip', title: 'Trip', itemCount: 1, imageUrl: null, url: 'https://app.example.test/memories/m2' },
    ],
    memoriesUrl: 'https://app.example.test/memories',
    unsubscribeUrl: 'https://app.example.test/api/public/memories/digest-unsubscribe/tok',
  },
};
