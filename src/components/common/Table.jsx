import React from 'react';
import styles from './Table.module.css';

const Table = ({
  columns,
  data,
  onRowClick,
  loading = false,
  emptyState = 'No data available',
}) => {
  if (loading) {
    return <div className={styles['table-loading']}>Loading...</div>;
  }

  if (!data || data.length === 0) {
    return <div className={styles['table-empty']}>{emptyState}</div>;
  }

  return (
    <div className={styles['table-wrapper']}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ width: col.width }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr
              key={row.id || idx}
              onClick={() => onRowClick?.(row)}
              className={onRowClick ? styles['table-row-clickable'] : ''}
            >
              {columns.map((col) => (
                <td key={col.key}>
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default Table;
