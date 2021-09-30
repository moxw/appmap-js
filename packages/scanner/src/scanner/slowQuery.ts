import { Event } from '@appland/models';
import Assertion from '../assertion';

export default function (
  timeAllowed = 1,
  queryInclude = [/SELECT/],
  queryExclude = [/pg_advisory_xact_lock/]
): Assertion {
  return Assertion.assert(
    'slow-query',
    'Slow SQL queries',
    'sql_query',
    (e: Event) => e.elapsedTime! < timeAllowed,
    (assertion: Assertion): void => {
      assertion.where = (e: Event) =>
        e.elapsedTime !== undefined &&
        queryInclude.some((pattern) => e.sqlQuery && e.sqlQuery.match(pattern)) &&
        !queryExclude.some((pattern) => e.sqlQuery && e.sqlQuery.match(pattern));
      assertion.description = `Slow SQL query (> ${timeAllowed * 1000}ms)`;
    }
  );
}
