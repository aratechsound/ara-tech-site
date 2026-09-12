const normalizedEventDate = (post) => String(post?.event_date || '');
const normalizedEventTime = (post) => String(post?.open_time || post?.start_time || '');

export const compareUpcomingWorks = (left, right) => {
    const dateOrder = normalizedEventDate(left).localeCompare(normalizedEventDate(right));
    if (dateOrder) return dateOrder;

    const leftTime = normalizedEventTime(left);
    const rightTime = normalizedEventTime(right);
    if (leftTime && rightTime) {
        const timeOrder = leftTime.localeCompare(rightTime);
        if (timeOrder) return timeOrder;
    } else if (!leftTime && rightTime) {
        // Date-only or multi-performance entries stay ahead of explicitly late events.
        return -1;
    } else if (leftTime && !rightTime) {
        return 1;
    }

    return Number(left?.id || 0) - Number(right?.id || 0);
};
