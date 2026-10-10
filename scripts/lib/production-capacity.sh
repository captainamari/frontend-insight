# Sourced by the production preflight and boundary tests; never count swap.
production_capacity_total_ok() {
  [[ "$1" =~ ^[0-9]+$ && "$1" -ge 16106127360 ]]
}
