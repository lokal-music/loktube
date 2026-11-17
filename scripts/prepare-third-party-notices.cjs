module.exports = async (context) => {
  require('./build-setup-ui.cjs')()
  const { prepareNotices } = await import('./prepare-third-party-notices.mjs')
  await prepareNotices(context)
}
