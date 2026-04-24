import ModelCard from './ModelCard'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'

interface Props {
  model: ModelCatalogEntry
  downloading: boolean
  progress?: number
  anyBusy: boolean
  onDownload: () => void
  onCancelDownload: () => void
  onDelete: () => void
  onActivate: () => void
}

export default function AsrModelCard(props: Props): React.JSX.Element {
  return <ModelCard {...props} activeUsageLabel="Wird für Transkription verwendet" />
}
