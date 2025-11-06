export type UrlDigestStage = 'crawl' | 'summary' | 'tagging' | 'slug';

export type UrlDigestPipelineStage = Exclude<UrlDigestStage, 'crawl'>;

export interface DigestPipelinePayload {
  pipeline?: boolean;
  remainingStages?: UrlDigestPipelineStage[];
}
