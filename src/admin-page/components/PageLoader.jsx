import BrandedLoader from '../../components/BrandedLoader'
import PageHeader from './PageHeader'

export default function PageLoader({ title, message }) {
  return (
    <>
      <PageHeader title={title} subtitle={message} />
      <div className="card"><BrandedLoader compact message={message} /></div>
    </>
  )
}
