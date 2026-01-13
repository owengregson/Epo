const sortFollowersByFollowingCount = (followers) => {
  return [...followers].sort((a, b) => b.followingCount - a.followingCount);
};

module.exports = {
  sortFollowersByFollowingCount,
};
