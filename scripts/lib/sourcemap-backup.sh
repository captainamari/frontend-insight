# Sourced by production and the isolated D5 restore proof. Caller provides compose.
sourcemap_backup() {
  compose run --rm --no-deps -T --entrypoint tar api --exclude='*.tmp' -C /var/lib/frontend-insight/sourcemaps -cf - . > "$1/sourcemaps.tar"
}
sourcemap_validate() {
  # Only server-generated hash filenames. Reject links and unexpected archive paths.
  tar -tf "$1/sourcemaps.tar" | awk '$0 != "./" && ($0 !~ /^\.\/[a-f0-9]+\.map$/ || length($0) != 70) {bad=1} END {exit bad}' || return 1
  tar -tvf "$1/sourcemaps.tar" | awk 'substr($0,1,1) != "-" && !(substr($0,1,1) == "d" && $NF == "./") {bad=1} END {exit bad}' || return 1
}
sourcemap_restore() {
  sourcemap_validate "$1" || return 1
  compose run --rm --no-deps -T --entrypoint sh api -c 'find /var/lib/frontend-insight/sourcemaps -type f -delete && tar -C /var/lib/frontend-insight/sourcemaps -xf -' < "$1/sourcemaps.tar"
}
