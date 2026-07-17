import { STATUS_ROWS } from "../data/status.js";

export default function StatusTable() {
  return (
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {STATUS_ROWS.map((row) => (
          <tr key={row.component}>
            <td>{row.component}</td>
            <td>{row.status}</td>
            <td>{row.notes}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
