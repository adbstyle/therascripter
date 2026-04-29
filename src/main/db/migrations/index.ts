import initialSchema from './001-initial-schema.sql?raw'
import addDiarizationPath from './002-add-diarization-path.sql?raw'
import addReviewAt from './003-add-review-at.sql?raw'
import addTaskCancelledStatus from './004-add-task-cancelled-status.sql?raw'
import addAlignedTranscriptAndExtractedPaths from './005-add-aligned-transcript-and-extracted-paths.sql?raw'
import addWordCount from './006-add-word-count.sql?raw'
import addSummarization from './007-add-summarization.sql?raw'
import resetSummarizationParseErrors from './008-reset-summarization-parse-errors.sql?raw'
import addQualityFlag from './009-add-quality-flag.sql?raw'
import dropPipelineVersion from './010-drop-pipeline-version.sql?raw'
import pipelineInversion from './011-pipeline-inversion.sql?raw'

export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  { version: 1, sql: initialSchema },
  { version: 2, sql: addDiarizationPath },
  { version: 3, sql: addReviewAt },
  { version: 4, sql: addTaskCancelledStatus },
  { version: 5, sql: addAlignedTranscriptAndExtractedPaths },
  { version: 6, sql: addWordCount },
  { version: 7, sql: addSummarization },
  { version: 8, sql: resetSummarizationParseErrors },
  { version: 9, sql: addQualityFlag },
  { version: 10, sql: dropPipelineVersion },
  { version: 11, sql: pipelineInversion }
]
