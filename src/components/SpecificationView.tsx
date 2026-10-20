import type { ReactNode } from 'react'

/** The existing My builds specification table, usable for one design or a comparison. */
export function SpecificationView({
  title,
  columns,
  rows,
  notice,
}: {
  title: string
  columns: readonly { id: string; name: string }[]
  rows: readonly { label: string; values: readonly ReactNode[]; different?: boolean }[]
  notice?: ReactNode
}) {
  return (
    <div className="comparison">
      <h3>{title}</h3>
      <div className="table-scroll">
        <table aria-label={title}>
          <thead>
            <tr>
              <th scope="col">Your decisions</th>
              {columns.map((column) => (
                <th scope="col" key={column.id}>
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className={row.different ? 'different' : ''}>
                <th scope="row">{row.label}</th>
                {row.values.map((value, index) => (
                  <td key={columns[index].id}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notice && <p className="muted small">{notice}</p>}
    </div>
  )
}
