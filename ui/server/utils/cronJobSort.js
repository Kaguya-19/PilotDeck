function parseTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortCronJobsByCreatedAt(jobs) {
  return jobs
    .map((job, index) => ({
      job,
      index,
      timestamp: parseTimestamp(job?.createdAt),
    }))
    .sort((left, right) => {
      if (left.timestamp !== null && right.timestamp !== null) {
        const timeDifference = right.timestamp - left.timestamp;
        return timeDifference !== 0 ? timeDifference : left.index - right.index;
      }
      if (left.timestamp !== null) {
        return -1;
      }
      if (right.timestamp !== null) {
        return 1;
      }
      return left.index - right.index;
    })
    .map(({ job }) => job);
}
