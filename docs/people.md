# People Registry

A unified system to manage identities across media: faces in photos/videos, voices in audio.

## Overview

**Goal**: Build a personal knowledge graph of people, linking biometric embeddings (voice, face) to canonical person records, enabling search/filter by person and surfacing interaction history.

**Principles**:
- **User data first**: Person records stored as vCards (`.vcf`) in user data folder
- **App data is derived**: Embeddings and clusters stored in SQLite (rebuildable)
- **Progressive enrichment**: Manual labeling improves auto-matching over time

## Data Architecture

```mermaid
graph TB
    subgraph UserData["MY_DATA_DIR/people/"]
        VCF1["alice.vcf"]
        VCF2["bob.vcf"]
    end

    subgraph AppData["app/my-life-db/database.sqlite"]
        People["people table"]
        Embeddings["person_embeddings table"]
        Clusters["person_clusters table"]
    end

    subgraph Sources["Content Sources"]
        Audio["Audio files<br/>(speaker embeddings)"]
        Photos["Photos/Videos<br/>(face embeddings)"]
    end

    VCF1 --> People
    VCF2 --> People
    Audio --> Embeddings
    Photos --> Embeddings
    Embeddings --> Clusters
    Clusters --> People
```

## Data Models

### Person (vCard + SQLite)

**User data** (`MY_DATA_DIR/people/{slug}.vcf`):
```
BEGIN:VCARD
VERSION:4.0
FN:Alice Chen
N:Chen;Alice;;;
NICKNAME:alicec
PHOTO;MEDIATYPE=image/jpeg:data:image/jpeg;base64,/9j/4AAQ...
X-VOICE-CLIP:data:audio/wav;base64,UklGRiQA...
NOTE:Met at 2024 conference
END:VCARD
```

**App data** (`people` table):
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| vcf_path | TEXT | Relative path to vCard (nullable for pending) |
| slug | TEXT UNIQUE | URL-safe identifier |
| display_name | TEXT | Name or auto-generated "Unknown #N" for pending |
| avatar | BLOB | Cached representative photo (thumbnail) |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

**Computed state**: `vcf_path IS NULL` → pending, otherwise identified.

vCard stores authoritative data for identified people. SQLite caches display_name + avatar for fast list rendering.

### Cluster (SQLite)

Persistent grouping of embeddings. Each cluster always belongs to a person (pending or identified).

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| person_id | TEXT FK | Linked person (always set) |
| type | TEXT | `voice` or `face` |
| centroid | BLOB | Average embedding vector |
| sample_count | INT | Number of embeddings in cluster |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

### Embedding (SQLite)

Stores biometric vectors extracted from media files.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| cluster_id | TEXT FK | Parent cluster (nullable) |
| type | TEXT | `voice` or `face` |
| vector | BLOB | Float32 array (512 for voice, 128 for face) |
| source_path | TEXT | File that produced this embedding |
| source_offset | TEXT | JSON: `{start, end}` for audio, `{frame, bbox}` for video |
| quality | REAL | Duration (voice) or face size (face) for filtering |
| manual_assignment | BOOLEAN | If TRUE, skip in auto-clustering |
| created_at | TEXT | ISO timestamp |

## Clustering

### Algorithm: Incremental Agglomerative Clustering

Industry research shows that [agglomerative hierarchical clustering (AHC)](https://google.github.io/speaker-id/publications/LstmDiarization/) and [spectral clustering](https://github.com/wenet-e2e/wespeaker) are standard for speaker diarization. For our incremental use case:

```mermaid
flowchart TD
    NewEmb[New embedding] --> CheckManual{manual_assignment?}
    CheckManual -->|Yes| Skip[Skip auto-clustering]
    CheckManual -->|No| FindNearest[Find nearest cluster centroid]
    FindNearest --> CheckSim{Cosine similarity > threshold?}

    CheckSim -->|Yes| AddToCluster[Add to existing cluster]
    AddToCluster --> UpdateCentroid[Update cluster centroid]

    CheckSim -->|No| CreateCluster[Create new cluster]
    CreateCluster --> CreatePerson[Create pending person]
    CreatePerson --> LinkCluster[Link cluster to person]
```

**Why not HDBSCAN?**
- HDBSCAN requires all points upfront, not suitable for incremental updates
- [WeSpeaker](https://github.com/wenet-e2e/wespeaker) uses UMAP + HDBSCAN for batch processing, but we need online clustering
- Simple centroid-based approach allows real-time assignment as new audio/photos arrive

**Centroid Update Formula**:
```
new_centroid = (old_centroid * n + new_embedding) / (n + 1)
```

### Similarity Threshold

| Type | Match Threshold |
|------|-----------------|
| Voice | > 0.85 cosine |
| Face | > 0.80 cosine |

Based on [FaceNet](https://arxiv.org/abs/1503.03832) research showing 128-dim embeddings achieve excellent clustering with simple thresholding. [Cosine similarity](https://medium.com/@sapkotabinit2002/speaker-identification-and-clustering-using-pyannote-dbscan-and-cosine-similarity-dfa08b5b2a24) is standard for normalized speaker embeddings.

### Cluster Operations

**Merge**: Combine two clusters into one
```
merged_centroid = (centroid_a * n_a + centroid_b * n_b) / (n_a + n_b)
```
- Update all embeddings in cluster B to point to cluster A
- Delete cluster B
- Recalculate centroid

**Remove embedding from cluster**:
- Unlink embedding from cluster (set `cluster_id = NULL`)
- If cluster becomes empty, delete it
- Otherwise, recalculate centroid excluding removed embedding:
```
new_centroid = (old_centroid * n - removed_embedding) / (n - 1)
```

**Periodic re-clustering** (optional background task):
- Run full AHC on unassigned embeddings where `manual_assignment = FALSE`
- Helps correct drift from incremental centroid updates
- Embeddings with `manual_assignment = TRUE` are never auto-clustered

## Digester Integration

```mermaid
sequenceDiagram
    participant File
    participant Digester
    participant DB

    File->>Digester: Audio/Video/Photo
    Digester->>DB: Extract embeddings

    loop Each embedding
        Digester->>DB: Find nearest cluster (cosine)
        alt similarity > threshold
            Digester->>DB: Add to cluster, update centroid
        else no match
            Digester->>DB: Create new cluster
        end
    end
```

### New Digesters

| Digester | Input | Output |
|----------|-------|--------|
| `speaker-embedding` | Audio with ASR result | Embeddings for each speaker |
| `face-embedding` | Photo/video | Embeddings for detected faces |

### Embedding Extraction

**Voice**: From ASR result (already in `HaidSpeechRecognitionResponse`):
- 512-dim vector per speaker (1 embedding per speaker per audio file)
- Multiple segments from same speaker are already aggregated into one embedding
- Store all segment timestamps in `source_offset` for clip-level review UI
- Filter by `total_duration` (quality metric)

**Face**: From face detection API (future):
- 128-dim vector per face ([FaceNet standard](https://arxiv.org/abs/1503.03832))
- Store bounding box, frame number for videos

## Workflows

### 1. Auto-Clustering Flow

For each new embedding (where `manual_assignment = FALSE`):

```mermaid
flowchart TD
    NewEmb[New embedding] --> FindMatch{Find cluster with similarity > threshold}
    FindMatch -->|Found| AddToCluster[Add to existing cluster]
    AddToCluster --> UpdateCentroid[Update centroid]

    FindMatch -->|Not found| CreateCluster[Create new cluster]
    CreateCluster --> CreatePending[Create pending person]
    CreatePending --> Link[Link cluster → person]
```

**Multiple clusters per person**: A person can have multiple clusters (even of the same type). Matching checks all clusters linked to a person - this captures variation (e.g., voice at different ages, different lighting for faces).

### 2. Identifying Pending People

```mermaid
flowchart TD
    Start[Pending people] --> ShowUI[Show in people list]
    ShowUI --> UserAction{User action}

    UserAction -->|"Name this person"| SetName[Set display_name]
    SetName --> CreateVCF[Create .vcf file]
    CreateVCF --> SetPath[Set vcf_path]

    UserAction -->|"Merge with another"| MergePeople[Merge two people]
    MergePeople --> MoveClusters[Move clusters to target]
    MoveClusters --> DeleteSource[Delete source people record]

    UserAction -->|"Remove embedding"| Unlink[Set embedding.cluster_id = NULL]
    Unlink --> SetManual[Set manual_assignment = TRUE]
```

### 3. Manual Assignment

When user manually assigns/unassigns an embedding:
- **Assign to person**: set `manual_assignment = TRUE`, link to appropriate cluster (or create new one for that person)
- **Unassign from person**: set `cluster_id = NULL`, keep `manual_assignment = TRUE`
- Embeddings with `manual_assignment = TRUE` are never touched by auto-clustering

### 4. Representative Selection

When user wants to change the representative photo/voice:
1. Show all embeddings in clusters linked to person
2. User selects preferred one
3. Extract clip/crop from source file
4. Encode as base64 in vCard (PHOTO/X-VOICE-CLIP)
5. Generate thumbnail and cache in `people.avatar`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/people` | GET | List all people (uses cached avatar) |
| `/api/people` | POST | Create person from vCard data |
| `/api/people/[slug]` | GET | Person details with linked clusters |
| `/api/people/[slug]` | PUT | Update vCard fields |
| `/api/people/[slug]` | DELETE | Remove person (orphans clusters) |
| `/api/people/[slug]/representative` | PUT | Set representative photo/voice |
| `/api/people/[slug]/merge` | POST | Merge another person into this one |
| `/api/people/embeddings/[id]/assign` | POST | Manually assign embedding to person |
| `/api/people/embeddings/[id]/unassign` | POST | Unassign embedding from person |

## UX

### People Page (`/people`)

Single unified page showing all people (both identified and pending):

```
┌─────────────────────────────────────────────────────────┐
│ People                                                  │
├─────────────────────────────────────────────────────────┤
│ Identified                                              │
│ ┌────────┐ ┌────────┐ ┌────────┐                       │
│ │ [foto] │ │ [foto] │ │ [foto] │                       │
│ │ Alice  │ │ Bob    │ │ Carol  │                       │
│ └────────┘ └────────┘ └────────┘                       │
│                                                         │
│ Pending (12)                                            │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐           │
│ │ [face] │ │ [🔊]   │ │ [face] │ │ [🔊]   │           │
│ │ Unk #1 │ │ Unk #2 │ │ Unk #3 │ │ Unk #4 │           │
│ └────────┘ └────────┘ └────────┘ └────────┘           │
└─────────────────────────────────────────────────────────┘
```

- Identified people shown first
- Pending people shown with auto-generated names ("Unknown #N")
- Avatar shows face crop or speaker icon
- Click any person → detail page

### Person Detail (`/people/[slug]`)

Same page for both identified and pending:

```
┌─────────────────────────────────────────────────────────┐
│ Unknown #1                              [Identify]      │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ Voice clips:                                            │
│ ┌──────────────────────────────────────────────────┐   │
│ │ 🔵 meeting.mp3                                    │   │
│ │   ▶ 0:12-0:45  ▶ 1:23-1:58  ▶ 3:02-3:15         │   │
│ │                                                   │   │
│ │ 🟢 interview.mp3                                  │   │
│ │   ▶ 0:00-2:30  ▶ 5:12-5:45                       │   │
│ └──────────────────────────────────────────────────┘   │
│                                                         │
│ Faces:                                                  │
│ ┌──────┐ ┌──────┐ ┌──────┐                             │
│ │ [😀] │ │ [😀] │ │ [😀] │                             │
│ └──────┘ └──────┘ └──────┘                             │
│                                                         │
│ Actions: [Merge with...] [Delete]                       │
└─────────────────────────────────────────────────────────┘
```

- Voice: show clips grouped by source file, colored by embedding
- Face: show face crops
- Each clip/face can be unassigned individually
- [Identify] button: enter name → creates vCard, status = identified
- [Merge with...]: select another person, move all clusters to target

### Review UI Details

**Voice clips**:
- One embedding may have multiple segments (same speaker in one file)
- Show all segments as playable clips
- Color-code by embedding (different files = different colors)
- User reviews at clip level, but unassign affects whole embedding

**Faces**:
- One embedding = one face crop
- Show as thumbnail grid

### Search Integration

- Add people filter to search UI
- Show person tags on file cards when detected
- People carousel in file inspector for media with faces/voices

## File Structure

```
MY_DATA_DIR/
├── people/                    # vCard storage (user data)
│   ├── alice-chen.vcf
│   ├── bob-smith.vcf
│   └── ...
├── inbox/
├── notes/
└── app/
    └── my-life-db/
        └── database.sqlite    # people, clusters, embeddings tables
```

## Migration Path

1. **Phase 1**: Schema + speaker digester
   - Create tables: people, person_clusters, person_embeddings
   - Implement speaker-embedding digester with auto-clustering
   - Auto-create pending person for new clusters
   - API for CRUD on people

2. **Phase 2**: People UI
   - Unified people page (identified + pending)
   - Person detail with clip/face review
   - Identify, merge, unassign actions
   - vCard read/write for identified people

3. **Phase 3**: Search integration
   - People filter in search
   - Person tags on cards
   - Timeline view

4. **Phase 4**: Face detection
   - Integrate face embedding API
   - Photo/video processing
   - Unified clustering across voice+face

## References

- [FaceNet: A Unified Embedding for Face Recognition and Clustering](https://arxiv.org/abs/1503.03832) - 128-dim face embeddings
- [Google Speaker Diarization with LSTM](https://google.github.io/speaker-id/publications/LstmDiarization/) - d-vector + clustering
- [WeSpeaker](https://github.com/wenet-e2e/wespeaker) - Production speaker verification toolkit
- [Speaker Clustering with DBSCAN](https://medium.com/@sapkotabinit2002/speaker-identification-and-clustering-using-pyannote-dbscan-and-cosine-similarity-dfa08b5b2a24) - Cosine similarity approach
