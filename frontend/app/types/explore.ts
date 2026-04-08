export interface ExplorePost {
  id: string;
  author: string;
  title: string;
  content?: string;
  mediaType?: "image" | "video";
  mediaPaths?: string[];
  mediaDir?: string;
  tags?: string[];
  createdAt: number;
}

export interface ExploreComment {
  id: string;
  postId: string;
  author: string;
  content: string;
  createdAt: number;
}

export interface ExplorePostWithComments extends ExplorePost {
  comments: ExploreComment[];
}

export interface ExplorePostsResponse {
  items: ExplorePost[];
  cursors: {
    first: string | null;
    last: string | null;
  };
  hasMore: {
    older: boolean;
    newer: boolean;
  };
}
