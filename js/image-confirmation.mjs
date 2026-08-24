const normalizedValue = (value) => String(value ?? '').trim();

export const hasPublicImage = (post) => Boolean(
    normalizedValue(post?.flyer_path)
    && post?.use_image_on_public_page !== false
);

export const publicImageChanged = (previous, next) => Boolean(previous) && (
    normalizedValue(previous.flyer_path) !== normalizedValue(next.flyer_path)
    || normalizedValue(previous.public_image_source_url) !== normalizedValue(next.public_image_source_url)
    || normalizedValue(previous.public_image_sha256) !== normalizedValue(next.public_image_sha256)
);

// The confirmation belongs to the exact public-image identity, not to taxonomy or copy fields.
export const resolveImageConfirmation = ({ previousPost, nextImage, requestedStatus, requestedPublicUse }) => {
    const imageChanged = publicImageChanged(previousPost, nextImage);
    return {
        imageChanged,
        image_usage_status: imageChanged ? 'unknown' : (requestedStatus || previousPost?.image_usage_status || 'unknown'),
        use_image_on_public_page: imageChanged ? false : Boolean(requestedPublicUse)
    };
};
