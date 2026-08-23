<?php
/**
 * REST routes for the wpxmcp companion plugin.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers and serves the wpxmcp/v1 namespace.
 */
class WPXMCP_REST {

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_REST|null
	 */
	private static $instance = null;

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_REST
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook up.
	 */
	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Only authenticated administrators reach any of this.
	 *
	 * @return true|WP_Error
	 */
	public function require_admin() {
		if ( ! is_user_logged_in() ) {
			return new WP_Error(
				'wpxmcp_unauthenticated',
				'Not authenticated. Send an Application Password via the Authorization header; if the header is being stripped by the host, add the passthrough rule from the wpxmcp README.',
				array( 'status' => 401 )
			);
		}
		if ( ! current_user_can( WPXMCP_ADMIN_CAP ) ) {
			return new WP_Error(
				'wpxmcp_forbidden',
				'This endpoint requires an administrator (manage_options). The authenticated user does not have it.',
				array( 'status' => 403 )
			);
		}
		return true;
	}

	/**
	 * Route table.
	 */
	public function register_routes() {
		$ns    = WPXMCP_NAMESPACE;
		$admin = array( $this, 'require_admin' );

		register_rest_route( $ns, '/site-info', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'site_info' ),
			'permission_callback' => $admin,
			'args'                => array(
				'include_health' => array( 'type' => 'boolean', 'default' => true ),
			),
		) );

		register_rest_route( $ns, '/cli', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'run_cli' ),
			'permission_callback' => $admin,
			'args'                => array(
				'command' => array( 'type' => 'string', 'required' => true ),
				'format'  => array( 'type' => 'string', 'default' => 'json' ),
			),
		) );

		register_rest_route( $ns, '/sql', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'run_sql' ),
			'permission_callback' => $admin,
			'args'                => array(
				'query'    => array( 'type' => 'string', 'required' => true ),
				'readonly' => array( 'type' => 'boolean', 'default' => true ),
				'max_rows' => array( 'type' => 'integer', 'default' => 200 ),
			),
		) );

		register_rest_route( $ns, '/meta', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_meta' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'set_meta' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( $ns, '/options', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_options' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'set_option' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( $ns, '/theme-mods', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_theme_mods' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'set_theme_mod' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( $ns, '/roles', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'get_roles' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/abilities', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'get_abilities' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/audit', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'get_audit' ),
			'permission_callback' => $admin,
		) );
	}

	/* ------------------------------------------------------------------ *
	 * Site intelligence
	 * ------------------------------------------------------------------ */

	/**
	 * Everything worth knowing about the install in one response.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function site_info( $request ) {
		global $wpdb, $wp_version;

		$theme = wp_get_theme();

		$info = array(
			'wordpress' => array(
				'version'      => $wp_version,
				'multisite'    => is_multisite(),
				'debug'        => defined( 'WP_DEBUG' ) && WP_DEBUG,
				'environment'  => function_exists( 'wp_get_environment_type' ) ? wp_get_environment_type() : 'unknown',
				'locale'       => get_locale(),
				'permalink'    => get_option( 'permalink_structure' ) ? 'pretty' : 'plain (?p=123) — set pretty permalinks for readable URLs',
				'table_prefix' => $wpdb->prefix,
				'https'        => is_ssl(),
				'memory_limit' => defined( 'WP_MEMORY_LIMIT' ) ? WP_MEMORY_LIMIT : ini_get( 'memory_limit' ),
			),
			'php'       => array(
				'version'              => PHP_VERSION,
				'memory_limit'         => ini_get( 'memory_limit' ),
				'max_execution_time'   => ini_get( 'max_execution_time' ),
				'upload_max_filesize'  => ini_get( 'upload_max_filesize' ),
				'post_max_size'        => ini_get( 'post_max_size' ),
				'max_input_vars'       => ini_get( 'max_input_vars' ),
				'extensions'           => array(
					'curl'  => extension_loaded( 'curl' ),
					'gd'    => extension_loaded( 'gd' ),
					'imagick' => extension_loaded( 'imagick' ),
					'mbstring' => extension_loaded( 'mbstring' ),
					'zip'   => extension_loaded( 'zip' ),
				),
			),
			'server'    => array(
				'software' => isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : 'unknown',
				'mysql'    => $wpdb->db_version(),
			),
			'theme'     => array(
				'name'      => $theme->get( 'Name' ),
				'stylesheet' => get_stylesheet(),
				'template'  => get_template(),
				'version'   => $theme->get( 'Version' ),
				'is_child'  => get_stylesheet() !== get_template(),
				'is_block_theme' => function_exists( 'wp_is_block_theme' ) ? wp_is_block_theme() : false,
			),
			'database'  => $this->database_stats(),
			'updates'   => $this->update_summary(),
			'cron'      => array(
				'disabled'      => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
				'overdue_events' => $this->overdue_cron_count(),
			),
			'writable'  => array(
				'themes'  => wp_is_writable( get_theme_root() ),
				'plugins' => wp_is_writable( WP_PLUGIN_DIR ),
				'uploads' => wp_is_writable( wp_upload_dir()['basedir'] ),
			),
		);

		if ( $request->get_param( 'include_health' ) ) {
			$info['site_health'] = $this->site_health();
		}

		return $info;
	}

	/**
	 * Table sizes and row counts.
	 *
	 * @return array
	 */
	private function database_stats() {
		global $wpdb;

		$tables = $wpdb->get_results( "SHOW TABLE STATUS", ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$total  = 0;
		$list   = array();

		foreach ( (array) $tables as $table ) {
			$size   = (int) $table['Data_length'] + (int) $table['Index_length'];
			$total += $size;
			$list[] = array(
				'table' => $table['Name'],
				'rows'  => (int) $table['Rows'],
				'bytes' => $size,
			);
		}

		usort( $list, static function ( $a, $b ) {
			return $b['bytes'] <=> $a['bytes'];
		} );

		$autoload = (int) $wpdb->get_var( "SELECT SUM(LENGTH(option_value)) FROM {$wpdb->options} WHERE autoload = 'yes'" ); // phpcs:ignore WordPress.DB

		return array(
			'total_bytes'          => $total,
			'total_mb'             => round( $total / 1048576, 2 ),
			'largest_tables'       => array_slice( $list, 0, 10 ),
			'autoloaded_bytes'     => $autoload,
			'autoloaded_note'      => $autoload > 1000000 ? 'Autoloaded options exceed 1 MB, which is loaded on every single request. Worth investigating.' : null,
			'post_revisions'       => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'revision'" ), // phpcs:ignore WordPress.DB
			'orphaned_postmeta'    => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} pm LEFT JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.ID IS NULL" ), // phpcs:ignore WordPress.DB
			'expired_transients'   => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value < %d", '_transient_timeout_%', time() ) ), // phpcs:ignore WordPress.DB
		);
	}

	/**
	 * Pending core, plugin and theme updates.
	 *
	 * @return array
	 */
	private function update_summary() {
		if ( ! function_exists( 'get_plugin_updates' ) ) {
			require_once ABSPATH . 'wp-admin/includes/update.php';
		}
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}

		$core    = function_exists( 'get_core_updates' ) ? get_core_updates() : array();
		$plugins = function_exists( 'get_plugin_updates' ) ? get_plugin_updates() : array();
		$themes  = function_exists( 'get_theme_updates' ) ? get_theme_updates() : array();

		$plugin_list = array();
		foreach ( (array) $plugins as $file => $data ) {
			$plugin_list[] = array(
				'plugin'  => $file,
				'name'    => isset( $data->Name ) ? $data->Name : $file, // phpcs:ignore WordPress.NamingConventions
				'current' => isset( $data->Version ) ? $data->Version : '', // phpcs:ignore WordPress.NamingConventions
				'new'     => isset( $data->update->new_version ) ? $data->update->new_version : '',
			);
		}

		return array(
			'core_update_available' => ! empty( $core ) && isset( $core[0]->response ) && 'upgrade' === $core[0]->response,
			'core_latest'           => ! empty( $core ) && isset( $core[0]->version ) ? $core[0]->version : null,
			'plugin_updates'        => count( $plugin_list ),
			'plugin_update_list'    => $plugin_list,
			'theme_updates'         => count( (array) $themes ),
		);
	}

	/**
	 * Count cron events that are overdue by more than an hour.
	 *
	 * @return int
	 */
	private function overdue_cron_count() {
		$crons = _get_cron_array();
		if ( ! is_array( $crons ) ) {
			return 0;
		}
		$overdue = 0;
		$cutoff  = time() - HOUR_IN_SECONDS;
		foreach ( $crons as $timestamp => $hooks ) {
			if ( $timestamp < $cutoff ) {
				$overdue += count( $hooks );
			}
		}
		return $overdue;
	}

	/**
	 * Runs the core Site Health direct tests.
	 *
	 * @return array
	 */
	private function site_health() {
		if ( ! class_exists( 'WP_Site_Health' ) ) {
			$file = ABSPATH . 'wp-admin/includes/class-wp-site-health.php';
			if ( ! file_exists( $file ) ) {
				return array( 'available' => false, 'reason' => 'WP_Site_Health is not available on this WordPress version.' );
			}
			require_once $file;
		}

		$health  = WP_Site_Health::get_instance();
		$tests   = WP_Site_Health::get_tests();
		$results = array();

		foreach ( $tests['direct'] as $key => $test ) {
			$method = isset( $test['test'] ) ? $test['test'] : null;
			if ( ! $method ) {
				continue;
			}
			$callable = is_string( $method ) ? array( $health, 'get_test_' . $method ) : $method;
			if ( ! is_callable( $callable ) ) {
				continue;
			}
			try {
				$result = call_user_func( $callable );
				if ( ! empty( $result['status'] ) && 'good' !== $result['status'] ) {
					$results[] = array(
						'test'   => $key,
						'label'  => isset( $result['label'] ) ? wp_strip_all_tags( $result['label'] ) : $key,
						'status' => $result['status'],
						'detail' => isset( $result['description'] ) ? wp_strip_all_tags( $result['description'] ) : '',
					);
				}
			} catch ( Throwable $e ) {
				$results[] = array( 'test' => $key, 'status' => 'error', 'detail' => $e->getMessage() );
			}
		}

		return array(
			'available'    => true,
			'issue_count'  => count( $results ),
			'issues'       => $results,
			'note'         => 'Only non-passing direct tests are listed. Async tests (loopback, HTTPS checks) are not run here.',
		);
	}

	/* ------------------------------------------------------------------ *
	 * WP-CLI emulation
	 * ------------------------------------------------------------------ */

	/**
	 * Delegate to the emulator.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function run_cli( $request ) {
		$command = (string) $request->get_param( 'command' );
		$format  = (string) $request->get_param( 'format' );

		$result = WPXMCP_CLI::run( $command, $format );

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		wpxmcp_audit( 'cli', array( 'command' => $command ) );
		return $result;
	}

	/* ------------------------------------------------------------------ *
	 * SQL
	 * ------------------------------------------------------------------ */

	/**
	 * Runs a query, enforcing read-only semantics a second time server-side.
	 *
	 * The MCP server already gates this, but a plugin that trusts its client is
	 * one misconfiguration away from being a SQL injection endpoint.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function run_sql( $request ) {
		global $wpdb;

		$query    = trim( (string) $request->get_param( 'query' ) );
		$readonly = (bool) $request->get_param( 'readonly' );
		$max_rows = min( 1000, max( 1, (int) $request->get_param( 'max_rows' ) ) );

		if ( '' === $query ) {
			return new WP_Error( 'wpxmcp_empty_query', 'No query supplied.', array( 'status' => 400 ) );
		}

		// Reject stacked statements outright.
		$without_strings = preg_replace( "/'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"/", "''", $query );
		if ( substr_count( rtrim( $without_strings, "; \t\n\r" ), ';' ) > 0 ) {
			return new WP_Error( 'wpxmcp_stacked_query', 'Multiple statements in one query are refused.', array( 'status' => 400 ) );
		}

		$is_read = (bool) preg_match( '/^\s*(select|show|describe|desc|explain|with)\b/i', $query );

		if ( $readonly && ! $is_read ) {
			return new WP_Error(
				'wpxmcp_readonly',
				'This endpoint was called in read-only mode but the statement is not a SELECT/SHOW/DESCRIBE/EXPLAIN.',
				array( 'status' => 400 )
			);
		}

		if ( ! $readonly ) {
			// Mutating SQL additionally requires the constant to be set in wp-config.php,
			// so a site owner must opt in on the server as well as in the client.
			if ( ! defined( 'WPXMCP_ALLOW_SQL_WRITES' ) || ! WPXMCP_ALLOW_SQL_WRITES ) {
				return new WP_Error(
					'wpxmcp_sql_writes_disabled',
					'Mutating SQL is disabled on this site. Add define( \'WPXMCP_ALLOW_SQL_WRITES\', true ); to wp-config.php to permit it — and prefer the REST API or WP-CLI, which run WordPress hooks and invalidate caches.',
					array( 'status' => 403 )
				);
			}
		}

		$wpdb->suppress_errors( true );
		$start = microtime( true );

		if ( $is_read ) {
			$rows = $wpdb->get_results( $query, ARRAY_A ); // phpcs:ignore WordPress.DB
		} else {
			$affected = $wpdb->query( $query ); // phpcs:ignore WordPress.DB
		}

		$elapsed = round( ( microtime( true ) - $start ) * 1000, 1 );
		$error   = $wpdb->last_error;
		$wpdb->suppress_errors( false );

		if ( $error ) {
			return new WP_Error( 'wpxmcp_sql_error', 'MySQL: ' . $error, array( 'status' => 400 ) );
		}

		wpxmcp_audit( 'sql', array( 'query' => substr( $query, 0, 500 ), 'readonly' => $is_read ) );

		if ( $is_read ) {
			$rows = is_array( $rows ) ? array_slice( $rows, 0, $max_rows ) : array();
			return array(
				'rows'       => $rows,
				'columns'    => ! empty( $rows ) ? array_keys( $rows[0] ) : array(),
				'row_count'  => count( $rows ),
				'elapsed_ms' => $elapsed,
			);
		}

		return array(
			'rows_affected' => (int) $affected,
			'elapsed_ms'    => $elapsed,
			'note'          => 'Raw SQL bypasses WordPress hooks. Object and page caches were not invalidated — run "cache flush" via run_wp_cli if the change should be visible immediately.',
		);
	}

	/* ------------------------------------------------------------------ *
	 * Meta, options, theme mods
	 * ------------------------------------------------------------------ */

	/**
	 * Read post meta, including keys not registered with show_in_rest.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function get_meta( $request ) {
		$post_id = (int) $request->get_param( 'post_id' );
		if ( ! $post_id || ! get_post( $post_id ) ) {
			return new WP_Error( 'wpxmcp_no_post', 'No post with that ID.', array( 'status' => 404 ) );
		}

		$include_protected = (bool) $request->get_param( 'include_protected' );
		$only              = array_filter( array_map( 'trim', explode( ',', (string) $request->get_param( 'keys' ) ) ) );

		$all = get_post_meta( $post_id );
		$out = array();

		foreach ( (array) $all as $key => $values ) {
			if ( $only && ! in_array( $key, $only, true ) ) {
				continue;
			}
			if ( ! $include_protected && ! $only && is_protected_meta( $key, 'post' ) ) {
				continue;
			}
			$value = count( $values ) === 1 ? maybe_unserialize( $values[0] ) : array_map( 'maybe_unserialize', $values );

			// Very large values (page-builder documents) are summarised rather than dumped.
			if ( is_string( $value ) && strlen( $value ) > 20000 ) {
				$out[ $key ] = array(
					'__truncated' => true,
					'length'      => strlen( $value ),
					'preview'     => substr( $value, 0, 2000 ),
					'note'        => 'Value truncated. Request this key explicitly via `keys` to receive it in full.',
				);
				continue;
			}
			$out[ $key ] = $value;
		}

		return array(
			'post_id'      => $post_id,
			'post_type'    => get_post_type( $post_id ),
			'meta'         => $out,
			'builder_hint' => $this->detect_builder( $post_id ),
		);
	}

	/**
	 * Flags page-builder content so the caller does not edit post_content in vain.
	 *
	 * @param int $post_id Post ID.
	 * @return string|null
	 */
	private function detect_builder( $post_id ) {
		$signatures = array(
			'_elementor_data'          => 'Elementor',
			'_et_pb_use_builder'       => 'Divi',
			'_fl_builder_data'         => 'Beaver Builder',
			'_bricks_page_content_2'   => 'Bricks',
			'_breakdance_data'         => 'Breakdance',
			'_seedprod_page'           => 'SeedProd',
			'_wpb_vc_js_status'        => 'WPBakery',
			'ct_builder_shortcodes'    => 'Oxygen',
		);

		foreach ( $signatures as $key => $builder ) {
			if ( metadata_exists( 'post', $post_id, $key ) ) {
				return $builder . ' owns this content. Its layout lives in post meta, not post_content — editing post_content will not change the page.';
			}
		}
		return null;
	}

	/**
	 * Write arbitrary post meta.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function set_meta( $request ) {
		$post_id = (int) $request->get_param( 'post_id' );
		$meta    = $request->get_param( 'meta' );

		if ( ! $post_id || ! get_post( $post_id ) ) {
			return new WP_Error( 'wpxmcp_no_post', 'No post with that ID.', array( 'status' => 404 ) );
		}
		if ( ! is_array( $meta ) || empty( $meta ) ) {
			return new WP_Error( 'wpxmcp_no_meta', 'Supply a `meta` object of key/value pairs.', array( 'status' => 400 ) );
		}
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return new WP_Error( 'wpxmcp_forbidden', 'You cannot edit that post.', array( 'status' => 403 ) );
		}

		$written = array();
		foreach ( $meta as $key => $value ) {
			$key = (string) $key;
			if ( null === $value ) {
				delete_post_meta( $post_id, $key );
				$written[ $key ] = null;
				continue;
			}
			update_post_meta( $post_id, $key, $value );
			$written[ $key ] = get_post_meta( $post_id, $key, true );
		}

		clean_post_cache( $post_id );
		wpxmcp_audit( 'set_meta', array( 'post_id' => $post_id, 'keys' => array_keys( $meta ) ) );

		return array( 'post_id' => $post_id, 'written' => $written );
	}

	/**
	 * Read options.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function get_options( $request ) {
		global $wpdb;

		$names  = array_filter( array_map( 'trim', explode( ',', (string) $request->get_param( 'names' ) ) ) );
		$search = (string) $request->get_param( 'search' );
		$limit  = min( 200, max( 1, (int) ( $request->get_param( 'limit' ) ?: 50 ) ) );

		$out = array();

		if ( $names ) {
			foreach ( $names as $name ) {
				$out[ $name ] = get_option( $name );
			}
			return array( 'options' => $out );
		}

		if ( $search ) {
			$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
				"SELECT option_name, autoload, LENGTH(option_value) AS len FROM {$wpdb->options} WHERE option_name LIKE %s ORDER BY len DESC LIMIT %d",
				'%' . $wpdb->esc_like( $search ) . '%',
				$limit
			), ARRAY_A );
		} else {
			$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
				"SELECT option_name, autoload, LENGTH(option_value) AS len FROM {$wpdb->options} WHERE autoload = 'yes' ORDER BY len DESC LIMIT %d",
				$limit
			), ARRAY_A );
		}

		foreach ( (array) $rows as $row ) {
			$value = get_option( $row['option_name'] );
			$out[] = array(
				'name'     => $row['option_name'],
				'autoload' => $row['autoload'],
				'bytes'    => (int) $row['len'],
				'value'    => ( is_string( $value ) && strlen( $value ) > 4000 ) ? substr( $value, 0, 4000 ) . '…[truncated]' : $value,
			);
		}

		return array(
			'filter'  => $search ? "name contains \"$search\"" : 'autoloaded options, largest first',
			'count'   => count( $out ),
			'options' => $out,
		);
	}

	/**
	 * Write an option.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function set_option( $request ) {
		$name = (string) $request->get_param( 'name' );
		if ( '' === $name ) {
			return new WP_Error( 'wpxmcp_no_option', 'Supply an option `name`.', array( 'status' => 400 ) );
		}

		// Options that would lock out the site or break the REST connection.
		$blocked = array( 'siteurl', 'home', 'active_plugins', 'template', 'stylesheet' );
		if ( in_array( $name, $blocked, true ) ) {
			return new WP_Error(
				'wpxmcp_protected_option',
				sprintf( 'The option "%s" is protected — writing it can lock you out of the site or break this connection. Use the dedicated tool instead (activate_theme, activate_plugin, or wp-admin for URLs).', $name ),
				array( 'status' => 403 )
			);
		}

		$value    = $request->get_param( 'value' );
		$autoload = $request->get_param( 'autoload' );
		$previous = get_option( $name );

		if ( null === $autoload ) {
			update_option( $name, $value );
		} else {
			update_option( $name, $value, (bool) $autoload );
		}

		wpxmcp_audit( 'set_option', array( 'name' => $name ) );

		return array( 'name' => $name, 'previous' => $previous, 'value' => get_option( $name ) );
	}

	/**
	 * Read the active theme's mods.
	 *
	 * @return array
	 */
	public function get_theme_mods() {
		$mods = get_theme_mods();
		return array(
			'theme' => get_stylesheet(),
			'mods'  => is_array( $mods ) ? $mods : array(),
			'note'  => 'Theme mods are per-theme. Switching theme resets them.',
		);
	}

	/**
	 * Write one theme mod.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function set_theme_mod( $request ) {
		$key = (string) $request->get_param( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'wpxmcp_no_key', 'Supply a theme mod `key`.', array( 'status' => 400 ) );
		}
		$previous = get_theme_mod( $key );
		set_theme_mod( $key, $request->get_param( 'value' ) );
		wpxmcp_audit( 'set_theme_mod', array( 'key' => $key ) );

		return array( 'theme' => get_stylesheet(), 'key' => $key, 'previous' => $previous, 'value' => get_theme_mod( $key ) );
	}

	/**
	 * Roles and their capabilities.
	 *
	 * @return array
	 */
	public function get_roles() {
		$roles = wp_roles()->roles;
		$out   = array();
		foreach ( (array) $roles as $slug => $role ) {
			$caps        = array_keys( array_filter( (array) $role['capabilities'] ) );
			$out[ $slug ] = array(
				'name'             => $role['name'],
				'capability_count' => count( $caps ),
				'notable'          => array_values( array_intersect( $caps, array( 'manage_options', 'edit_posts', 'publish_posts', 'edit_others_posts', 'upload_files', 'edit_theme_options', 'activate_plugins', 'edit_themes', 'list_users', 'moderate_comments' ) ) ),
			);
		}
		return array( 'roles' => $out );
	}

	/**
	 * Bridge to the Abilities API when a plugin provides it under a different shape.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function get_abilities( $request ) {
		$search = (string) $request->get_param( 'search' );
		$out    = array();

		if ( function_exists( 'wp_get_abilities' ) ) {
			foreach ( (array) wp_get_abilities() as $ability ) {
				$name = is_object( $ability ) && method_exists( $ability, 'get_name' ) ? $ability->get_name() : ( is_array( $ability ) ? ( $ability['name'] ?? '' ) : '' );
				if ( $search && false === stripos( $name, $search ) ) {
					continue;
				}
				$out[] = array(
					'name'        => $name,
					'label'       => is_object( $ability ) && method_exists( $ability, 'get_label' ) ? $ability->get_label() : null,
					'description' => is_object( $ability ) && method_exists( $ability, 'get_description' ) ? $ability->get_description() : null,
				);
			}
		}

		return array(
			'abilities_api_present' => function_exists( 'wp_get_abilities' ),
			'count'                 => count( $out ),
			'abilities'             => $out,
		);
	}

	/**
	 * Site-side audit trail.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function get_audit( $request ) {
		$log   = get_option( 'wpxmcp_audit_log', array() );
		$limit = min( 500, max( 1, (int) ( $request->get_param( 'limit' ) ?: 100 ) ) );
		$log   = is_array( $log ) ? array_slice( $log, -$limit ) : array();

		return array( 'count' => count( $log ), 'entries' => array_reverse( $log ) );
	}
}
