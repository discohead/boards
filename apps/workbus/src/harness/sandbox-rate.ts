// What a sandbox container costs (harness/sandbox.ts), apart from the module that runs one, so the
// app's views can price container time without bringing in the container code.
/**
 * A basic container's cost per second, as provisioned (1/4 vCPU, 1 GiB, 4 GB) at Workers Containers'
 * rates: $0.000020 per vCPU-second, $0.0000025 per GiB-second of memory, $0.00000007 per GB-second
 * of disk. Conservative: the platform bills CPU by use, and this counts it as provisioned.
 */
export const BASIC_USD_PER_SECOND = 0.25 * 0.00002 + 1 * 0.0000025 + 4 * 0.00000007
