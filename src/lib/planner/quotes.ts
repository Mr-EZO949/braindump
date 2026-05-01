// Curated productivity / momentum quotes for the Lock In dialog.
// Picked deterministically from the day-of-year so the quote stays stable
// within a calendar day but changes daily. Short on purpose — they appear
// above the focus list and shouldn't compete with content for attention.

export const PRODUCTIVITY_QUOTES: { text: string; author: string }[] = [
  { text: "Action is the foundational key to all success.", author: "Pablo Picasso" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "Either you run the day or the day runs you.", author: "Jim Rohn" },
  { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { text: "Discipline equals freedom.", author: "Jocko Willink" },
  { text: "Done is better than perfect.", author: "Sheryl Sandberg" },
  { text: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese proverb" },
  { text: "Direction is more important than speed.", author: "Richard L. Evans" },
  { text: "Motion creates emotion.", author: "Tony Robbins" },
  { text: "Small daily improvements compound into staggering results.", author: "Robin Sharma" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { text: "Amateurs sit and wait for inspiration. The rest of us just get up and go to work.", author: "Stephen King" },
  { text: "It is not enough to be busy. The question is: what are we busy about?", author: "Henry David Thoreau" },
  { text: "What gets measured gets managed.", author: "Peter Drucker" },
  { text: "Focus is a matter of deciding what things you're not going to do.", author: "John Carmack" },
  { text: "The shorter way to do many things is to do only one thing at a time.", author: "Mozart" },
];

function dayOfYear(now: Date = new Date()): number {
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function getQuoteOfTheDay(now: Date = new Date()) {
  const idx = dayOfYear(now) % PRODUCTIVITY_QUOTES.length;
  return PRODUCTIVITY_QUOTES[idx];
}
