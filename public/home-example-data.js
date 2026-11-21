export const exampleCategories = [
  {
    id: 'economy',
    name: 'Economy',
    channel: 'rewards',
    examples: [
      { label: 'Wallet', caption: 'Example wallet', wallet: true },
      { label: 'Daily reward', title: 'Daily reward', body: 'You earned 120 Gear.\nDaily streak: 4', divider: true },
      { label: 'Work reward', title: 'Work complete', body: 'You earned 45 Gear.', divider: true },
      { label: 'Bank deposit', title: 'Deposit complete', body: 'Deposited 100 Gear into Bank.', divider: true },
      { label: 'Bank withdrawal', title: 'Withdrawal complete', body: 'Withdrew 50 Gear from Bank.', divider: true },
      { label: 'Member payment', title: 'Payment sent', body: 'wobblingbottom paid springleaf 75 Gear.', divider: true },
      {
        label: 'Server shop',
        channel: 'shop',
        title: 'Server shop',
        body: 'Event Pass - 250 Gear\nJoin the next community event.\n\nColor Token - 80 Gear\nUnlock a seasonal color role.',
        divider: true
      },
      {
        label: 'Multi-currency price',
        channel: 'shop',
        title: 'Event Pass',
        body: 'Join the next community event.\n\nAvailable prices\n250 Gear\n100 Gear + 20 Gongs\n\nChoose how you want to pay.',
        divider: true
      },
      { label: 'Purchase', channel: 'shop', title: 'Purchase complete', body: 'You bought Event Pass for 250 Gear.', divider: true },
      { label: 'Inventory', title: 'Your inventory', body: '1 - Event Pass\nJoin the next community event.\n\n2 - Color Token\nUnlock a seasonal color role.', divider: true },
      { label: 'Use an item', title: 'Item used', body: 'You used Color Token.', divider: true },
      {
        label: 'Leaderboard',
        channel: 'leaderboards',
        image: { file: 'economy-leaderboard-example.png', width: 1200, height: 428 },
        summary: 'mossandiron leads with 1,280 Gear, followed by wobblingbottom with 596 and springleaf with 420.'
      },
      {
        label: 'Purchase log',
        channel: 'economy-logs',
        title: 'Purchase',
        body: 'wobblingbottom bought Event Pass for 250 Gear.',
        divider: true
      }
    ]
  },
  {
    id: 'levels',
    name: 'Levels',
    channel: 'levels',
    examples: [
      {
        label: 'Level card',
        image: { file: 'level-card-example.png', width: 1008, height: 189 },
        summary: 'Springleaf is level 7, rank 4, with 5,620 XP and 780 XP to the next level.'
      },
      { label: 'Level-up announcement', body: 'Congrats, @springleaf! You reached level 7.', plain: true },
      { label: 'Role reward announcement', body: '@springleaf reached level 10 and earned the Veteran role.', plain: true }
    ]
  },
  {
    id: 'moderation',
    name: 'Moderation',
    channel: 'mod-logs',
    examples: [
      { label: 'Timeout log', body: 'Timeout: springleaf\nMod: ember\nLength: 10 min\nReason: repeated spam' },
      { label: 'Warning DM', direct: true, body: 'You were warned in Crazyland for posting outside the trade channel' },
      { label: 'Cleared warning DM', direct: true, body: "Warning 'posting outside the trade channel' has been cleared from you" },
      {
        label: 'Case history',
        title: 'Modlogs for springleaf',
        body: 'Case 24 - Timeout\nMod: ember\nLength: 10 minutes\nReason: repeated spam',
        divider: true
      },
      { label: 'AutoMod block', body: 'Case #25 - AutoMod block: springleaf\nMod: Discord AutoMod\nReason: repeated mentions\nChannel: #general' },
      { label: 'Kick log', body: 'Kick: nightfern\nMod: ember\nReason: repeated harassment' },
      { label: 'Ban log', body: 'Ban: nightfern\nMod: ember\nReason: repeated raid spam' },
      { label: 'Unban log', body: 'Unban: nightfern\nMod: ember\nReason: appeal approved' },
      { label: 'Purge log', body: 'Purge: #general\nMod: ember\nReason: spam cleanup\nDeleted 12 messages' }
    ]
  },
  {
    id: 'members',
    name: 'Members',
    channel: 'welcome',
    examples: [
      {
        label: 'Welcome card',
        image: { file: 'welcome-card-example.png', width: 1008, height: 189 },
        summary: 'Welcome to Crazyland, springleaf!'
      },
      {
        label: 'Goodbye card',
        channel: 'goodbye',
        image: { file: 'goodbye-card-example.png', width: 1008, height: 189 },
        summary: 'springleaf left Crazyland.'
      }
    ]
  },
  {
    id: 'tools',
    name: 'Tools',
    channel: 'announcements',
    examples: [
      { label: 'Regular embed', title: 'Game night', body: 'Meet in #lobby on Friday at 19:00.' },
      { label: 'Components V2 message', title: 'Community build contest', body: 'Post your build in #showcase by Sunday.', divider: true }
    ]
  },
  {
    id: 'alerts',
    name: 'Creator alerts',
    channel: 'creator-alerts',
    examples: [
      { label: 'Twitch stream', title: 'mossandiron is live on Twitch', body: 'Building a cozy village' },
      { label: 'YouTube upload', title: 'mossandiron posted on YouTube', body: 'Five designs for a starter base' },
      { label: 'Instagram post', title: 'mossandiron posted on Instagram', body: 'A first look at the finished village' },
      { label: 'TikTok video', title: 'mossandiron posted on TikTok', body: 'One quick trick for better rooftops' }
    ]
  }
];
