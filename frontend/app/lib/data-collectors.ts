/**
 * Data Collector definitions.
 *
 * Mirrors the iOS DataCollectView categories but reorganized into
 * five high-level groups: Time, Health, Diet, Communication, Content.
 */

export type SourceStatus = "available" | "limited" | "manual" | "future";
export type Platform = "iPhone" | "Mac" | "Watch" | "iPhone, Watch" | "iPhone, Mac" | "All";

export interface DataSource {
  id: string;
  name: string;
  description: string;
  platform: Platform;
  status: SourceStatus;
}

export interface Collector {
  id: string;
  name: string;
  /** Lucide icon name */
  icon: string;
  description: string;
  sources: DataSource[];
}

export interface CollectorCategory {
  id: string;
  name: string;
  /** Lucide icon name */
  icon: string;
  collectors: Collector[];
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const categories: CollectorCategory[] = [
  {
    id: "time",
    name: "Time",
    icon: "Clock",
    collectors: [
      {
        id: "screen-time",
        name: "Screen Time",
        icon: "Monitor",
        description: "App usage, pickups, and total screen hours",
        sources: [
          { id: "screen_total", name: "Total Screen Time", description: "Daily screen usage duration", platform: "iPhone", status: "available" },
          { id: "app_usage", name: "Per-App Usage", description: "Time spent in each app", platform: "iPhone", status: "available" },
          { id: "app_category", name: "App Category Usage", description: "Time by category (social, productivity…)", platform: "iPhone", status: "available" },
          { id: "pickups", name: "Phone Pickups", description: "How often you pick up your phone", platform: "iPhone", status: "available" },
          { id: "notifications", name: "Notifications", description: "Notification count by app", platform: "iPhone", status: "available" },
        ],
      },
      {
        id: "calendar",
        name: "Calendar",
        icon: "Calendar",
        description: "Events, meetings, and schedule blocks",
        sources: [
          { id: "calendar", name: "Calendar Events", description: "Meetings, appointments, time blocks", platform: "All", status: "available" },
          { id: "meeting_time", name: "Meeting Time", description: "Hours in meetings per day/week", platform: "All", status: "available" },
        ],
      },
      {
        id: "focus",
        name: "Focus Sessions",
        icon: "Target",
        description: "Deep work blocks and focus mode tracking",
        sources: [
          { id: "focus_mode", name: "Focus Mode", description: "Active focus mode and schedule", platform: "iPhone, Mac", status: "limited" },
          { id: "deep_work", name: "Deep Work Sessions", description: "Focused uninterrupted work blocks", platform: "All", status: "manual" },
          { id: "active_app", name: "Active App Time", description: "Time per application on Mac", platform: "Mac", status: "limited" },
        ],
      },
    ],
  },
  {
    id: "health",
    name: "Health",
    icon: "Heart",
    collectors: [
      {
        id: "activity",
        name: "Activity",
        icon: "Footprints",
        description: "Steps, distance, flights, active energy",
        sources: [
          { id: "steps", name: "Steps", description: "Daily step count", platform: "iPhone, Watch", status: "available" },
          { id: "distance", name: "Distance", description: "Walking + running distance", platform: "iPhone, Watch", status: "available" },
          { id: "flights", name: "Flights Climbed", description: "Floors ascended", platform: "iPhone, Watch", status: "available" },
          { id: "active_energy", name: "Active Energy", description: "Calories burned through activity", platform: "iPhone, Watch", status: "available" },
          { id: "exercise_min", name: "Exercise Minutes", description: "Time spent exercising", platform: "iPhone, Watch", status: "available" },
          { id: "stand_hours", name: "Stand Hours", description: "Hours with standing activity", platform: "Watch", status: "available" },
        ],
      },
      {
        id: "vitals",
        name: "Heart & Vitals",
        icon: "HeartPulse",
        description: "Heart rate, HRV, blood oxygen, VO2 max",
        sources: [
          { id: "heart_rate", name: "Heart Rate", description: "Resting, walking, and workout HR", platform: "iPhone, Watch", status: "available" },
          { id: "hrv", name: "Heart Rate Variability", description: "HRV — stress and recovery indicator", platform: "Watch", status: "available" },
          { id: "blood_oxygen", name: "Blood Oxygen", description: "SpO2 saturation level", platform: "Watch", status: "available" },
          { id: "respiratory_rate", name: "Respiratory Rate", description: "Breaths per minute during sleep", platform: "Watch", status: "available" },
          { id: "vo2max", name: "VO2 Max", description: "Cardio fitness level", platform: "Watch", status: "available" },
        ],
      },
      {
        id: "sleep",
        name: "Sleep",
        icon: "Moon",
        description: "Duration, stages, bedtime patterns",
        sources: [
          { id: "sleep_duration", name: "Sleep Duration", description: "Total time asleep", platform: "iPhone, Watch", status: "available" },
          { id: "sleep_stages", name: "Sleep Stages", description: "REM, deep, core, awake breakdown", platform: "Watch", status: "available" },
          { id: "bedtime", name: "Bedtime & Wake Time", description: "Sleep schedule tracking", platform: "iPhone, Watch", status: "available" },
          { id: "sleep_consistency", name: "Sleep Consistency", description: "Schedule regularity score", platform: "iPhone", status: "available" },
        ],
      },
      {
        id: "body",
        name: "Body Metrics",
        icon: "Scale",
        description: "Weight, body composition, walking steadiness",
        sources: [
          { id: "body_weight", name: "Body Weight", description: "Weight measurements", platform: "iPhone", status: "available" },
          { id: "walking_steadiness", name: "Walking Steadiness", description: "Fall risk assessment", platform: "iPhone", status: "available" },
        ],
      },
      {
        id: "mindfulness",
        name: "Mindfulness",
        icon: "Brain",
        description: "Meditation, mood, gratitude, journaling",
        sources: [
          { id: "mindful_min", name: "Mindful Minutes", description: "Meditation session duration", platform: "iPhone, Watch", status: "available" },
          { id: "mood", name: "Mood", description: "Emotional state logging", platform: "iPhone", status: "available" },
          { id: "mood_journal", name: "Mood Journal", description: "Free-text mood entries", platform: "All", status: "manual" },
          { id: "gratitude", name: "Gratitude Log", description: "Things you're grateful for", platform: "All", status: "manual" },
          { id: "journal", name: "Journal Entries", description: "Diary and free writing", platform: "All", status: "manual" },
        ],
      },
      {
        id: "workouts",
        name: "Workouts",
        icon: "Dumbbell",
        description: "Exercise sessions, routes, running, swimming, cycling",
        sources: [
          { id: "workouts", name: "Workouts", description: "All workout types with duration and calories", platform: "iPhone, Watch", status: "available" },
          { id: "workout_routes", name: "Workout Routes", description: "GPS tracks for outdoor workouts", platform: "iPhone, Watch", status: "available" },
          { id: "running", name: "Running Metrics", description: "Pace, cadence, stride length, power", platform: "Watch", status: "available" },
          { id: "swimming", name: "Swimming", description: "Laps, strokes, distance, SWOLF", platform: "Watch", status: "available" },
          { id: "cycling", name: "Cycling", description: "Distance, speed, power", platform: "iPhone, Watch", status: "available" },
        ],
      },
    ],
  },
  {
    id: "diet",
    name: "Diet",
    icon: "UtensilsCrossed",
    collectors: [
      {
        id: "water",
        name: "Water",
        icon: "Droplets",
        description: "Daily hydration tracking",
        sources: [
          { id: "water", name: "Water Intake", description: "Daily water consumption", platform: "iPhone", status: "available" },
        ],
      },
      {
        id: "caffeine",
        name: "Caffeine",
        icon: "Coffee",
        description: "Coffee and tea consumption",
        sources: [
          { id: "caffeine", name: "Caffeine Intake", description: "Coffee and tea consumption tracking", platform: "iPhone", status: "available" },
        ],
      },
      {
        id: "meals",
        name: "Meals",
        icon: "Utensils",
        description: "What you ate, when, photos",
        sources: [
          { id: "meals", name: "Meals", description: "What you ate, when, photos", platform: "All", status: "manual" },
          { id: "calories_in", name: "Calories Consumed", description: "Dietary energy intake", platform: "iPhone", status: "available" },
        ],
      },
      {
        id: "substances",
        name: "Supplements & Alcohol",
        icon: "Pill",
        description: "Vitamins, medications, drinks",
        sources: [
          { id: "supplements", name: "Supplements", description: "Vitamins and medications", platform: "All", status: "manual" },
          { id: "alcohol", name: "Alcohol", description: "Drinks consumed", platform: "All", status: "manual" },
        ],
      },
    ],
  },
  {
    id: "communication",
    name: "Communication",
    icon: "MessageCircle",
    collectors: [
      {
        id: "messages",
        name: "Messages",
        icon: "MessageSquare",
        description: "iMessage, WhatsApp, Telegram, Discord",
        sources: [
          { id: "imessage", name: "iMessage", description: "Message count and conversations", platform: "iPhone, Mac", status: "future" },
          { id: "chat_logs", name: "Chat Logs", description: "WhatsApp, Telegram, Discord, Slack", platform: "All", status: "future" },
        ],
      },
      {
        id: "email",
        name: "Email",
        icon: "Mail",
        description: "Inbox activity and correspondence",
        sources: [
          { id: "email", name: "Email Volume", description: "Emails sent and received per day", platform: "All", status: "limited" },
        ],
      },
      {
        id: "calls",
        name: "Phone & Video Calls",
        icon: "Phone",
        description: "Call history, duration, FaceTime, Zoom",
        sources: [
          { id: "phone_calls", name: "Phone Calls", description: "Call frequency and duration", platform: "iPhone", status: "limited" },
          { id: "video_calls", name: "Video Calls", description: "FaceTime, Zoom, Meet duration", platform: "All", status: "limited" },
        ],
      },
      {
        id: "social",
        name: "Social Media",
        icon: "Share2",
        description: "Posts, comments, likes across platforms",
        sources: [
          { id: "social_posts", name: "Social Media", description: "Posts, comments, likes", platform: "All", status: "future" },
        ],
      },
    ],
  },
  {
    id: "content",
    name: "Content",
    icon: "BookOpen",
    collectors: [
      {
        id: "articles",
        name: "Articles",
        icon: "FileText",
        description: "Web articles, blogs, newsletters",
        sources: [
          { id: "articles", name: "Articles Read", description: "Web articles and blog posts", platform: "All", status: "future" },
        ],
      },
      {
        id: "videos",
        name: "Videos",
        icon: "Play",
        description: "YouTube, streaming platforms",
        sources: [
          { id: "youtube", name: "YouTube History", description: "Videos watched, channels, time", platform: "All", status: "future" },
          { id: "movies_tv", name: "Movies & TV", description: "What you watched, ratings", platform: "All", status: "manual" },
        ],
      },
      {
        id: "podcasts",
        name: "Podcasts",
        icon: "Headphones",
        description: "Audio content and episodes",
        sources: [
          { id: "podcasts", name: "Podcasts", description: "Episodes listened, duration, shows", platform: "iPhone", status: "limited" },
        ],
      },
      {
        id: "books",
        name: "Books",
        icon: "BookOpen",
        description: "Reading progress and highlights",
        sources: [
          { id: "books", name: "Books & Reading", description: "Titles, reading time, progress", platform: "iPhone", status: "limited" },
          { id: "books_finished", name: "Books Finished", description: "Completed books list", platform: "All", status: "manual" },
        ],
      },
      {
        id: "ai-chats",
        name: "AI Chats",
        icon: "Bot",
        description: "Claude, ChatGPT conversation sessions",
        sources: [
          { id: "claude_sessions", name: ".claude Sessions", description: "Claude Code session history", platform: "Mac", status: "available" },
        ],
      },
      {
        id: "music",
        name: "Music",
        icon: "Music",
        description: "Listening history, artists, genres",
        sources: [
          { id: "music", name: "Music Listening", description: "Songs, artists, genres, duration", platform: "All", status: "available" },
        ],
      },
      {
        id: "dev-work",
        name: "Developer Work",
        icon: "Terminal",
        description: "Git commits, code written, IDE usage",
        sources: [
          { id: "git_commits", name: "Git Commits", description: "Commit frequency, repos, LOC changed", platform: "Mac", status: "available" },
          { id: "git_activity", name: "Git Activity", description: "Branches, PRs, code review", platform: "Mac", status: "available" },
          { id: "terminal_history", name: "Terminal History", description: "Shell commands executed", platform: "Mac", status: "available" },
          { id: "code_written", name: "Code Written", description: "Lines of code by language", platform: "Mac", status: "available" },
          { id: "ide_usage", name: "IDE Usage", description: "Time in Xcode, VS Code, etc.", platform: "Mac", status: "limited" },
        ],
      },
      {
        id: "photos",
        name: "Photos",
        icon: "Camera",
        description: "Photos taken and screenshots",
        sources: [
          { id: "photos_taken", name: "Photos Taken", description: "Photo count per day", platform: "iPhone", status: "available" },
          { id: "screenshots", name: "Screenshots", description: "Screenshot frequency", platform: "iPhone", status: "available" },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a collector by id across all categories. */
export function findCollector(id: string): { category: CollectorCategory; collector: Collector } | null {
  for (const cat of categories) {
    const c = cat.collectors.find((c) => c.id === id);
    if (c) return { category: cat, collector: c };
  }
  return null;
}

/** Status display config. */
export const statusConfig: Record<SourceStatus, { label: string; className: string }> = {
  available: { label: "Available", className: "text-emerald-600 dark:text-emerald-400" },
  limited: { label: "Limited", className: "text-amber-600 dark:text-amber-400" },
  manual: { label: "Manual", className: "text-blue-600 dark:text-blue-400" },
  future: { label: "Future", className: "text-muted-foreground" },
};

