export type Lang = "en" | "bn";

/**
 * Visitor-facing strings of the chat panel. Bangla baseline comes from the owner-approved demo. Text the owner writes (title, subtitle, greeting, quick replies, away text, offline message) is shown as written in
 * both languages: we do not translate it. Only the built-in defaults below change with the language.
 */
export const STR = {
  en: {
    defaultSubtitle: "We reply here", hi: "Hi there. How can we help?", ph: "Write a message", send: "Send", langShort: "EN",
    langAria: "EN. Switch language to Bangla", close: "Close chat", sendAria: "Send message", msgLabel: "Your message", conv: "Conversation", quick: "Quick questions",
    away: "We're away right now. Leave your email and we'll reply.", emailLabel: "Your email", emailPh: "you@example.com", emailBad: "Enter a valid email address.", emailFail: "Could not save. Try again.", emailDone: "Thanks. We'll reply by email.",
    connecting: "Connecting…", errTitle: "We could not connect.", errBody: "Check your connection and try again.", retry: "Try again",
    blockedTitle: "Chat is not available here.", blockedBody: "This chat only works on the website it was set up for.",
    offTitle: "We are offline right now.", offBody: "Chat is not available at the moment. Please try again later.", reconnecting: "Reconnecting…",
    you: "You: ", support: "Support: ", sent: "Sent", sending: "Sending…", notSent: "Not sent. Try again",
    tooFast: "One moment, then send again.", tooMany: "You are sending messages too quickly. Wait a moment.", unavailable: "Chat is not available right now.", sendFail: "Could not send. Check your connection and try again.",
    preName: "Your name (optional)", preEmail: "Your email (optional)", preStart: "Start chat", preSkip: "Skip", preHi: "Hi! Send us a message and we will reply here.",
  },
  bn: {
    defaultSubtitle: "আমরা এখানেই উত্তর দিই", hi: "হ্যালো! কীভাবে সাহায্য করতে পারি?", ph: "বার্তা লিখুন", send: "পাঠান", langShort: "বাং",
    langAria: "বাং। ভাষা বদলে English করুন", close: "চ্যাট বন্ধ করুন", sendAria: "বার্তা পাঠান", msgLabel: "আপনার বার্তা", conv: "কথোপকথন", quick: "দ্রুত প্রশ্ন",
    away: "আমরা এখন অফলাইনে। ইমেইল রেখে যান, আমরা উত্তর দেব।", emailLabel: "আপনার ইমেইল", emailPh: "you@example.com", emailBad: "সঠিক ইমেইল ঠিকানা লিখুন।", emailFail: "সংরক্ষণ হয়নি। আবার চেষ্টা করুন।", emailDone: "ধন্যবাদ। আমরা ইমেইলে উত্তর দেব।",
    connecting: "সংযোগ হচ্ছে…", errTitle: "সংযোগ করা যায়নি।", errBody: "ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।", retry: "আবার চেষ্টা করুন",
    blockedTitle: "এখানে চ্যাট চালু নেই।", blockedBody: "এই চ্যাট শুধু যে ওয়েবসাইটের জন্য বানানো, সেখানেই চলে।",
    offTitle: "আমরা এখন অফলাইনে।", offBody: "এই মুহূর্তে চ্যাট চালু নেই। পরে আবার চেষ্টা করুন।", reconnecting: "আবার সংযোগ হচ্ছে…",
    you: "আপনি: ", support: "সাপোর্ট: ", sent: "পাঠানো হয়েছে", sending: "পাঠানো হচ্ছে…", notSent: "পাঠানো যায়নি। আবার চেষ্টা করুন",
    tooFast: "এক মুহূর্ত অপেক্ষা করে আবার পাঠান।", tooMany: "আপনি খুব দ্রুত বার্তা পাঠাচ্ছেন। একটু অপেক্ষা করুন।", unavailable: "এই মুহূর্তে চ্যাট চালু নেই।", sendFail: "পাঠানো যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।",
    preName: "আপনার নাম (ঐচ্ছিক)", preEmail: "আপনার ইমেইল (ঐচ্ছিক)", preStart: "চ্যাট শুরু করুন", preSkip: "এড়িয়ে যান", preHi: "হ্যালো! একটি বার্তা পাঠান, আমরা এখানেই উত্তর দেব।",
  },
} as const satisfies Record<Lang, Record<string, string>>;
export type Strings = Record<keyof (typeof STR)["en"], string>;
