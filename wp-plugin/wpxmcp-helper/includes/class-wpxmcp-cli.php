<?php
/**
 * WP-CLI command emulation.
 *
 * These run in PHP inside WordPress, so no WP-CLI binary, shell access or SSH
 * is needed on the host. The allowlist is enforced here as well as in the MCP
 * server — the plugin must not trust its client.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Emulated WP-CLI.
 */
class WPXMCP_CLI {

	/**
	 * Commands this plugin will run, mapped to handlers.
	 *
	 * @return array
	 */
	private static function commands() {
		return array(
			'cache flush'                => 'cmd_cache_flush',
			'core version'               => 'cmd_core_version',
			'core check-update'          => 'cmd_core_check_update',
			'core verify-checksums'      => 'cmd_core_verify_checksums',
			'cron event list'            => 'cmd_cron_event_list',
			'cron event run'             => 'cmd_cron_event_run',
			'db size'                    => 'cmd_db_size',
			'db tables'                  => 'cmd_db_tables',
			'option get'                 => 'cmd_option_get',
			'option list'                => 'cmd_option_list',
			'option update'              => 'cmd_option_update',
			'option delete'              => 'cmd_option_delete',
			'plugin list'                => 'cmd_plugin_list',
			'plugin get'                 => 'cmd_plugin_get',
			'plugin activate'            => 'cmd_plugin_activate',
			'plugin deactivate'          => 'cmd_plugin_deactivate',
			'plugin install'             => 'cmd_plugin_install',
			'plugin update'              => 'cmd_plugin_update',
			'plugin delete'              => 'cmd_plugin_delete',
			'post list'                  => 'cmd_post_list',
			'post meta get'              => 'cmd_post_meta_get',
			'post meta list'             => 'cmd_post_meta_list',
			'post meta update'           => 'cmd_post_meta_update',
			'post meta delete'           => 'cmd_post_meta_delete',
			'rewrite flush'              => 'cmd_rewrite_flush',
			'rewrite list'               => 'cmd_rewrite_list',
			'role list'                  => 'cmd_role_list',
			'search-replace'             => 'cmd_search_replace',
			'theme list'                 => 'cmd_theme_list',
			'theme get'                  => 'cmd_theme_get',
			'theme activate'             => 'cmd_theme_activate',
			'theme install'              => 'cmd_theme_install',
			'theme update'               => 'cmd_theme_update',
			'theme mod list'             => 'cmd_theme_mod_list',
			'theme mod get'              => 'cmd_theme_mod_get',
			'theme mod set'              => 'cmd_theme_mod_set',
			'transient delete'           => 'cmd_transient_delete',
			'transient get'              => 'cmd_transient_get',
			'user list'                  => 'cmd_user_list',
			'user get'                   => 'cmd_user_get',
			'user meta get'              => 'cmd_user_meta_get',
			'user meta update'           => 'cmd_user_meta_update',
			'user add-role'              => 'cmd_user_add_role',
			'user remove-role'           => 'cmd_user_remove_role',
			'menu list'                  => 'cmd_menu_list',
			'menu item list'             => 'cmd_menu_item_list',
			'sidebar list'               => 'cmd_sidebar_list',
			'widget list'                => 'cmd_widget_list',
			'maintenance-mode status'    => 'cmd_maintenance_status',
			'maintenance-mode activate'  => 'cmd_maintenance_activate',
			'maintenance-mode deactivate' => 'cmd_maintenance_deactivate',
		);
	}

	/**
	 * Parse and dispatch.
	 *
	 * @param string $input  Raw command, without the leading "wp".
	 * @param string $format Requested output format.
	 * @return array|WP_Error
	 */
	public static function run( $input, $format = 'json' ) {
		$input = trim( preg_replace( '/^wp\s+/', '', trim( $input ) ) );

		if ( '' === $input ) {
			return new WP_Error( 'wpxmcp_empty_command', 'No command supplied.', array( 'status' => 400 ) );
		}

		// Longest-prefix match, so "plugin activate x" beats "plugin".
		$commands = self::commands();
		$matched  = null;
		foreach ( array_keys( $commands ) as $candidate ) {
			if ( $input === $candidate || 0 === strpos( $input, $candidate . ' ' ) ) {
				if ( null === $matched || strlen( $candidate ) > strlen( $matched ) ) {
					$matched = $candidate;
				}
			}
		}

		if ( null === $matched ) {
			return new WP_Error(
				'wpxmcp_command_not_allowed',
				sprintf( 'The command "%s" is not on the allowlist. The allowlist is default-deny; see list_cli_commands for what is permitted.', esc_html( $input ) ),
				array( 'status' => 403 )
			);
		}

		$remainder = trim( substr( $input, strlen( $matched ) ) );
		list( $args, $flags ) = self::parse_args( $remainder );

		$handler = array( __CLASS__, $commands[ $matched ] );
		if ( ! is_callable( $handler ) ) {
			return new WP_Error( 'wpxmcp_not_implemented', sprintf( '"%s" is allowlisted but not implemented.', $matched ), array( 'status' => 501 ) );
		}

		try {
			$result = call_user_func( $handler, $args, $flags );
		} catch ( Throwable $e ) {
			return new WP_Error( 'wpxmcp_command_failed', $e->getMessage(), array( 'status' => 500 ) );
		}

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return array(
			'command'   => $matched,
			'args'      => $args,
			'flags'     => $flags,
			'exit_code' => 0,
			'data'      => $result,
			'stdout'    => self::format_output( $result, $format ),
		);
	}

	/**
	 * Splits positional arguments from --flags, honouring quotes.
	 *
	 * @param string $input Remainder of the command line.
	 * @return array{0:array,1:array}
	 */
	private static function parse_args( $input ) {
		$args  = array();
		$flags = array();

		if ( '' === trim( $input ) ) {
			return array( $args, $flags );
		}

		preg_match_all( '/(?:--([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|\'([^\']*)\'|(\S+)))?)|"([^"]*)"|\'([^\']*)\'|(\S+)/', $input, $matches, PREG_SET_ORDER );

		foreach ( $matches as $match ) {
			if ( ! empty( $match[1] ) ) {
				$value = '';
				foreach ( array( 2, 3, 4 ) as $index ) {
					if ( isset( $match[ $index ] ) && '' !== $match[ $index ] ) {
						$value = $match[ $index ];
						break;
					}
				}
				$flags[ $match[1] ] = ( '' === $value ) ? true : $value;
				continue;
			}
			foreach ( array( 5, 6, 7 ) as $index ) {
				if ( isset( $match[ $index ] ) && '' !== $match[ $index ] ) {
					$args[] = $match[ $index ];
					break;
				}
			}
		}

		return array( $args, $flags );
	}

	/**
	 * Renders a result in the requested shape.
	 *
	 * @param mixed  $data   Result.
	 * @param string $format json|table|csv|count|ids.
	 * @return string
	 */
	private static function format_output( $data, $format ) {
		if ( 'count' === $format ) {
			return (string) ( is_array( $data ) ? count( $data ) : 1 );
		}
		if ( 'ids' === $format && is_array( $data ) ) {
			$ids = array();
			foreach ( $data as $row ) {
				if ( is_array( $row ) && isset( $row['ID'] ) ) {
					$ids[] = $row['ID'];
				} elseif ( is_array( $row ) && isset( $row['id'] ) ) {
					$ids[] = $row['id'];
				}
			}
			return implode( ' ', $ids );
		}
		if ( ( 'table' === $format || 'csv' === $format ) && is_array( $data ) && isset( $data[0] ) && is_array( $data[0] ) ) {
			$columns = array_keys( $data[0] );
			$lines   = array( implode( 'csv' === $format ? ',' : "\t", $columns ) );
			foreach ( $data as $row ) {
				$cells = array();
				foreach ( $columns as $column ) {
					$value   = isset( $row[ $column ] ) ? $row[ $column ] : '';
					$cells[] = is_scalar( $value ) ? (string) $value : wp_json_encode( $value );
				}
				$lines[] = implode( 'csv' === $format ? ',' : "\t", $cells );
			}
			return implode( "\n", $lines );
		}
		return wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
	}

	/* ------------------------------------------------------------------ *
	 * Commands
	 * ------------------------------------------------------------------ */

	/** @return array */
	public static function cmd_cache_flush() {
		wp_cache_flush();
		return array( 'success' => true, 'message' => 'Object cache flushed. Page caches from caching plugins are separate and may still be serving old output.' );
	}

	/** @return array */
	public static function cmd_core_version() {
		global $wp_version;
		return array( 'version' => $wp_version );
	}

	/** @return array */
	public static function cmd_core_check_update() {
		require_once ABSPATH . 'wp-admin/includes/update.php';
		wp_version_check();
		$updates = get_core_updates();
		return array( 'updates' => $updates );
	}

	/** @return array */
	public static function cmd_core_verify_checksums() {
		global $wp_version;

		$response = wp_remote_get( 'https://api.wordpress.org/core/checksums/1.0/?version=' . rawurlencode( $wp_version ) . '&locale=en_US' );
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'wpxmcp_checksums_unavailable', 'Could not reach api.wordpress.org: ' . $response->get_error_message() );
		}

		$body = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( empty( $body['checksums'] ) ) {
			return new WP_Error( 'wpxmcp_checksums_unavailable', 'No checksums published for version ' . $wp_version . '.' );
		}

		$modified = array();
		$missing  = array();

		foreach ( $body['checksums'] as $file => $checksum ) {
			// wp-content is expected to differ; only core files matter.
			if ( 0 === strpos( $file, 'wp-content/' ) ) {
				continue;
			}
			$path = ABSPATH . $file;
			if ( ! file_exists( $path ) ) {
				$missing[] = $file;
				continue;
			}
			if ( md5_file( $path ) !== $checksum ) {
				$modified[] = $file;
			}
		}

		return array(
			'version'        => $wp_version,
			'modified_files' => $modified,
			'missing_files'  => $missing,
			'verdict'        => ( empty( $modified ) && empty( $missing ) )
				? 'All core files match the official checksums.'
				: 'Core files differ from the official release. Unexpected modifications are a common sign of compromise — investigate before dismissing them.',
		);
	}

	/** @return array */
	public static function cmd_cron_event_list() {
		$crons = _get_cron_array();
		$out   = array();
		foreach ( (array) $crons as $timestamp => $hooks ) {
			foreach ( $hooks as $hook => $events ) {
				foreach ( $events as $event ) {
					$out[] = array(
						'hook'          => $hook,
						'next_run_gmt'  => gmdate( 'c', $timestamp ),
						'next_run_in_s' => $timestamp - time(),
						'schedule'      => isset( $event['schedule'] ) ? $event['schedule'] : 'one-off',
					);
				}
			}
		}
		return $out;
	}

	/**
	 * @param array $args Positional args.
	 * @return array|WP_Error
	 */
	public static function cmd_cron_event_run( $args ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the hook name to run.' );
		}
		do_action( $args[0] );
		return array( 'success' => true, 'hook' => $args[0] );
	}

	/** @return array */
	public static function cmd_db_size() {
		global $wpdb;
		$rows  = $wpdb->get_results( "SHOW TABLE STATUS", ARRAY_A ); // phpcs:ignore WordPress.DB
		$total = 0;
		foreach ( (array) $rows as $row ) {
			$total += (int) $row['Data_length'] + (int) $row['Index_length'];
		}
		return array( 'bytes' => $total, 'mb' => round( $total / 1048576, 2 ), 'tables' => count( (array) $rows ) );
	}

	/** @return array */
	public static function cmd_db_tables() {
		global $wpdb;
		$rows = $wpdb->get_results( "SHOW TABLE STATUS", ARRAY_A ); // phpcs:ignore WordPress.DB
		$out  = array();
		foreach ( (array) $rows as $row ) {
			$out[] = array(
				'name'  => $row['Name'],
				'rows'  => (int) $row['Rows'],
				'bytes' => (int) $row['Data_length'] + (int) $row['Index_length'],
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return mixed
	 */
	public static function cmd_option_get( $args ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the option name.' );
		}
		return array( 'name' => $args[0], 'value' => get_option( $args[0] ) );
	}

	/**
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array
	 */
	public static function cmd_option_list( $args, $flags ) {
		global $wpdb;
		$search = isset( $flags['search'] ) ? (string) $flags['search'] : '';
		$limit  = isset( $flags['limit'] ) ? (int) $flags['limit'] : 100;

		if ( $search ) {
			$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
				"SELECT option_name, autoload, LENGTH(option_value) AS len FROM {$wpdb->options} WHERE option_name LIKE %s ORDER BY len DESC LIMIT %d",
				'%' . $wpdb->esc_like( str_replace( '*', '', $search ) ) . '%',
				$limit
			), ARRAY_A );
		} else {
			$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
				"SELECT option_name, autoload, LENGTH(option_value) AS len FROM {$wpdb->options} ORDER BY len DESC LIMIT %d",
				$limit
			), ARRAY_A );
		}
		return (array) $rows;
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_option_update( $args ) {
		if ( count( $args ) < 2 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: option update <name> <value>' );
		}
		$blocked = array( 'siteurl', 'home', 'active_plugins', 'template', 'stylesheet' );
		if ( in_array( $args[0], $blocked, true ) ) {
			return new WP_Error( 'wpxmcp_protected_option', sprintf( '"%s" is protected — writing it can lock you out of the site.', $args[0] ) );
		}
		$previous = get_option( $args[0] );
		update_option( $args[0], $args[1] );
		wpxmcp_audit( 'cli option update', array( 'name' => $args[0] ) );
		return array( 'name' => $args[0], 'previous' => $previous, 'value' => get_option( $args[0] ) );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_option_delete( $args ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the option name.' );
		}
		$deleted = delete_option( $args[0] );
		wpxmcp_audit( 'cli option delete', array( 'name' => $args[0] ) );
		return array( 'name' => $args[0], 'deleted' => $deleted );
	}

	/**
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array
	 */
	public static function cmd_plugin_list( $args, $flags ) {
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$plugins = get_plugins();
		$updates = get_site_transient( 'update_plugins' );
		$status  = isset( $flags['status'] ) ? (string) $flags['status'] : '';
		$out     = array();

		foreach ( $plugins as $file => $data ) {
			$active = is_plugin_active( $file );
			$state  = $active ? 'active' : 'inactive';
			if ( $status && $status !== $state ) {
				continue;
			}
			$out[] = array(
				'name'    => $data['Name'],
				'plugin'  => $file,
				'status'  => $state,
				'version' => $data['Version'],
				'update'  => isset( $updates->response[ $file ] ) ? 'available' : 'none',
				'update_version' => isset( $updates->response[ $file ]->new_version ) ? $updates->response[ $file ]->new_version : null,
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_plugin_get( $args ) {
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the plugin slug or file.' );
		}
		foreach ( get_plugins() as $file => $data ) {
			if ( $file === $args[0] || 0 === strpos( $file, $args[0] . '/' ) || $args[0] === dirname( $file ) ) {
				return array_merge( array( 'plugin' => $file, 'status' => is_plugin_active( $file ) ? 'active' : 'inactive' ), $data );
			}
		}
		return new WP_Error( 'wpxmcp_not_found', sprintf( 'No installed plugin matching "%s".', $args[0] ) );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_plugin_activate( $args ) {
		if ( ! function_exists( 'activate_plugin' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$file = self::resolve_plugin_file( $args[0] ?? '' );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		$result = activate_plugin( $file );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		wpxmcp_audit( 'cli plugin activate', array( 'plugin' => $file ) );
		return array( 'success' => true, 'plugin' => $file, 'status' => 'active' );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_plugin_deactivate( $args ) {
		if ( ! function_exists( 'deactivate_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$file = self::resolve_plugin_file( $args[0] ?? '' );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		deactivate_plugins( $file );
		wpxmcp_audit( 'cli plugin deactivate', array( 'plugin' => $file ) );
		return array( 'success' => true, 'plugin' => $file, 'status' => 'inactive' );
	}

	/**
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array|WP_Error
	 */
	public static function cmd_plugin_install( $args, $flags ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the plugin slug.' );
		}
		$result = self::install_package( 'plugin', $args[0] );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( ! empty( $flags['activate'] ) ) {
			self::cmd_plugin_activate( array( $args[0] ) );
			$result['activated'] = true;
		}
		return $result;
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_plugin_update( $args ) {
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once ABSPATH . 'wp-admin/includes/update.php';

		$file = self::resolve_plugin_file( $args[0] ?? '' );
		if ( is_wp_error( $file ) ) {
			return $file;
		}

		wp_update_plugins();
		$upgrader = new Plugin_Upgrader( new WP_Ajax_Upgrader_Skin() );
		$result   = $upgrader->upgrade( $file );

		if ( is_wp_error( $result ) ) {
			return $result;
		}
		wpxmcp_audit( 'cli plugin update', array( 'plugin' => $file ) );
		return array( 'success' => (bool) $result, 'plugin' => $file );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_plugin_delete( $args ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';

		$file = self::resolve_plugin_file( $args[0] ?? '' );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		if ( is_plugin_active( $file ) ) {
			return new WP_Error( 'wpxmcp_plugin_active', 'Deactivate the plugin before deleting it.' );
		}
		$deleted = delete_plugins( array( $file ) );
		if ( is_wp_error( $deleted ) ) {
			return $deleted;
		}
		wpxmcp_audit( 'cli plugin delete', array( 'plugin' => $file ) );
		return array( 'success' => true, 'plugin' => $file );
	}

	/**
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array
	 */
	public static function cmd_post_list( $args, $flags ) {
		$query = new WP_Query( array(
			'post_type'      => isset( $flags['post_type'] ) ? explode( ',', (string) $flags['post_type'] ) : 'post',
			'post_status'    => isset( $flags['post_status'] ) ? explode( ',', (string) $flags['post_status'] ) : 'any',
			'posts_per_page' => isset( $flags['posts_per_page'] ) ? (int) $flags['posts_per_page'] : 20,
			's'              => isset( $flags['s'] ) ? (string) $flags['s'] : '',
			'no_found_rows'  => true,
		) );

		$out = array();
		foreach ( $query->posts as $post ) {
			$out[] = array(
				'ID'          => $post->ID,
				'post_title'  => $post->post_title,
				'post_name'   => $post->post_name,
				'post_status' => $post->post_status,
				'post_type'   => $post->post_type,
				'post_date'   => $post->post_date,
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return mixed
	 */
	public static function cmd_post_meta_get( $args ) {
		if ( count( $args ) < 2 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: post meta get <id> <key>' );
		}
		return array( 'post_id' => (int) $args[0], 'key' => $args[1], 'value' => get_post_meta( (int) $args[0], $args[1], true ) );
	}

	/**
	 * @param array $args Args.
	 * @return array
	 */
	public static function cmd_post_meta_list( $args ) {
		$post_id = (int) ( $args[0] ?? 0 );
		$out     = array();
		foreach ( (array) get_post_meta( $post_id ) as $key => $values ) {
			$value = maybe_unserialize( $values[0] );
			$out[] = array(
				'post_id' => $post_id,
				'meta_key' => $key,
				'meta_value' => is_scalar( $value ) ? ( strlen( (string) $value ) > 500 ? substr( (string) $value, 0, 500 ) . '…' : $value ) : '[' . gettype( $value ) . ']',
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_post_meta_update( $args ) {
		if ( count( $args ) < 3 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: post meta update <id> <key> <value>' );
		}
		update_post_meta( (int) $args[0], $args[1], $args[2] );
		wpxmcp_audit( 'cli post meta update', array( 'post_id' => (int) $args[0], 'key' => $args[1] ) );
		return array( 'success' => true, 'post_id' => (int) $args[0], 'key' => $args[1] );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_post_meta_delete( $args ) {
		if ( count( $args ) < 2 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: post meta delete <id> <key>' );
		}
		delete_post_meta( (int) $args[0], $args[1] );
		return array( 'success' => true, 'post_id' => (int) $args[0], 'key' => $args[1] );
	}

	/** @return array */
	public static function cmd_rewrite_flush() {
		flush_rewrite_rules( false );
		wpxmcp_audit( 'cli rewrite flush' );
		return array( 'success' => true, 'message' => 'Rewrite rules flushed.' );
	}

	/** @return array */
	public static function cmd_rewrite_list() {
		global $wp_rewrite;
		$rules = $wp_rewrite->wp_rewrite_rules();
		$out   = array();
		foreach ( (array) $rules as $pattern => $target ) {
			$out[] = array( 'match' => $pattern, 'query' => $target );
		}
		return array_slice( $out, 0, 200 );
	}

	/** @return array */
	public static function cmd_role_list() {
		$out = array();
		foreach ( wp_roles()->roles as $slug => $role ) {
			$out[] = array( 'name' => $slug, 'role' => $role['name'], 'capabilities' => count( array_filter( (array) $role['capabilities'] ) ) );
		}
		return $out;
	}

	/**
	 * Search and replace across the database.
	 *
	 * Always honours --dry-run; the MCP server forces a dry run before the real one.
	 *
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array|WP_Error
	 */
	public static function cmd_search_replace( $args, $flags ) {
		global $wpdb;

		if ( count( $args ) < 2 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: search-replace <old> <new> [--dry-run]' );
		}

		$old     = (string) $args[0];
		$new     = (string) $args[1];
		$dry_run = ! empty( $flags['dry-run'] );

		if ( '' === $old ) {
			return new WP_Error( 'wpxmcp_empty_search', 'The search string cannot be empty.' );
		}

		// Restricted to the tables where content actually lives; core structural
		// tables are excluded so a replace cannot corrupt the install.
		$targets = array(
			$wpdb->posts    => array( 'ID', array( 'post_content', 'post_title', 'post_excerpt' ) ),
			$wpdb->postmeta => array( 'meta_id', array( 'meta_value' ) ),
			$wpdb->options  => array( 'option_id', array( 'option_value' ) ),
			$wpdb->comments => array( 'comment_ID', array( 'comment_content' ) ),
			$wpdb->terms    => array( 'term_id', array( 'name' ) ),
		);

		$report  = array();
		$changed = 0;

		foreach ( $targets as $table => $spec ) {
			list( $pk, $columns ) = $spec;

			foreach ( $columns as $column ) {
				$rows = $wpdb->get_results( $wpdb->prepare( // phpcs:ignore WordPress.DB
					"SELECT `$pk` AS pk, `$column` AS val FROM `$table` WHERE `$column` LIKE %s LIMIT 5000",
					'%' . $wpdb->esc_like( $old ) . '%'
				), ARRAY_A );

				if ( empty( $rows ) ) {
					continue;
				}

				$count   = 0;
				$samples = array();

				foreach ( $rows as $row ) {
					$value = $row['val'];

					// Serialised data must be replaced structurally, never by string
					// substitution, or the length prefixes break and the value is lost.
					if ( is_serialized( $value ) ) {
						$unserialized = maybe_unserialize( $value );
						$replaced     = self::deep_replace( $unserialized, $old, $new );
						$new_value    = maybe_serialize( $replaced );
					} else {
						$new_value = str_replace( $old, $new, $value );
					}

					if ( $new_value === $value ) {
						continue;
					}

					$count++;
					if ( count( $samples ) < 3 ) {
						$samples[] = array(
							'pk'     => $row['pk'],
							'before' => substr( (string) $value, 0, 200 ),
							'after'  => substr( (string) $new_value, 0, 200 ),
						);
					}

					if ( ! $dry_run ) {
						$wpdb->update( $table, array( $column => $new_value ), array( $pk => $row['pk'] ) ); // phpcs:ignore WordPress.DB
					}
				}

				if ( $count > 0 ) {
					$changed  += $count;
					$report[] = array(
						'table'   => $table,
						'column'  => $column,
						'rows'    => $count,
						'samples' => $samples,
					);
				}
			}
		}

		if ( ! $dry_run ) {
			wp_cache_flush();
			wpxmcp_audit( 'cli search-replace', array( 'old' => $old, 'new' => $new, 'rows' => $changed ) );
		}

		return array(
			'dry_run'       => $dry_run,
			'search'        => $old,
			'replace'       => $new,
			'rows_affected' => $changed,
			'report'        => $report,
			'note'          => $dry_run
				? 'Dry run — nothing was written. Serialised values are handled structurally, so lengths stay correct.'
				: 'Applied, and the object cache was flushed. Page caches from caching plugins are separate.',
		);
	}

	/**
	 * Recursive replace that preserves array and object structure.
	 *
	 * @param mixed  $data Data.
	 * @param string $old  Needle.
	 * @param string $new  Replacement.
	 * @return mixed
	 */
	private static function deep_replace( $data, $old, $new ) {
		if ( is_string( $data ) ) {
			return str_replace( $old, $new, $data );
		}
		if ( is_array( $data ) ) {
			$out = array();
			foreach ( $data as $key => $value ) {
				$out[ $key ] = self::deep_replace( $value, $old, $new );
			}
			return $out;
		}
		if ( is_object( $data ) ) {
			$clone = clone $data;
			foreach ( get_object_vars( $clone ) as $key => $value ) {
				$clone->$key = self::deep_replace( $value, $old, $new );
			}
			return $clone;
		}
		return $data;
	}

	/**
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array
	 */
	public static function cmd_theme_list( $args, $flags ) {
		$out     = array();
		$current = get_stylesheet();
		$updates = get_site_transient( 'update_themes' );

		foreach ( wp_get_themes() as $slug => $theme ) {
			$out[] = array(
				'name'    => $theme->get( 'Name' ),
				'stylesheet' => $slug,
				'status'  => $slug === $current ? 'active' : 'inactive',
				'version' => $theme->get( 'Version' ),
				'update'  => isset( $updates->response[ $slug ] ) ? 'available' : 'none',
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_theme_get( $args ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the theme stylesheet.' );
		}
		$theme = wp_get_theme( $args[0] );
		if ( ! $theme->exists() ) {
			return new WP_Error( 'wpxmcp_not_found', sprintf( 'No theme "%s" is installed.', $args[0] ) );
		}
		return array(
			'name'        => $theme->get( 'Name' ),
			'stylesheet'  => $theme->get_stylesheet(),
			'template'    => $theme->get_template(),
			'version'     => $theme->get( 'Version' ),
			'author'      => wp_strip_all_tags( (string) $theme->get( 'Author' ) ),
			'description' => wp_strip_all_tags( (string) $theme->get( 'Description' ) ),
			'status'      => get_stylesheet() === $theme->get_stylesheet() ? 'active' : 'inactive',
		);
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_theme_activate( $args ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the theme stylesheet.' );
		}
		$theme = wp_get_theme( $args[0] );
		if ( ! $theme->exists() ) {
			return new WP_Error( 'wpxmcp_not_found', sprintf( 'No theme "%s" is installed.', $args[0] ) );
		}
		switch_theme( $theme->get_stylesheet() );
		wpxmcp_audit( 'cli theme activate', array( 'theme' => $args[0] ) );
		return array( 'success' => true, 'active_theme' => get_stylesheet() );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_theme_install( $args ) {
		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the theme slug.' );
		}
		return self::install_package( 'theme', $args[0] );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_theme_update( $args ) {
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		require_once ABSPATH . 'wp-admin/includes/update.php';

		if ( empty( $args[0] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the theme stylesheet.' );
		}
		wp_update_themes();
		$upgrader = new Theme_Upgrader( new WP_Ajax_Upgrader_Skin() );
		$result   = $upgrader->upgrade( $args[0] );

		return is_wp_error( $result ) ? $result : array( 'success' => (bool) $result, 'theme' => $args[0] );
	}

	/** @return array */
	public static function cmd_theme_mod_list() {
		$out = array();
		foreach ( (array) get_theme_mods() as $key => $value ) {
			$out[] = array( 'key' => $key, 'value' => is_scalar( $value ) ? $value : wp_json_encode( $value ) );
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array
	 */
	public static function cmd_theme_mod_get( $args ) {
		return array( 'key' => $args[0] ?? '', 'value' => get_theme_mod( $args[0] ?? '' ) );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_theme_mod_set( $args ) {
		if ( count( $args ) < 2 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: theme mod set <key> <value>' );
		}
		set_theme_mod( $args[0], $args[1] );
		return array( 'success' => true, 'key' => $args[0], 'value' => get_theme_mod( $args[0] ) );
	}

	/**
	 * @param array $args Args.
	 * @return array
	 */
	public static function cmd_transient_delete( $args ) {
		if ( empty( $args[0] ) ) {
			return array( 'success' => false, 'message' => 'Supply the transient name.' );
		}
		return array( 'success' => delete_transient( $args[0] ), 'name' => $args[0] );
	}

	/**
	 * @param array $args Args.
	 * @return array
	 */
	public static function cmd_transient_get( $args ) {
		return array( 'name' => $args[0] ?? '', 'value' => get_transient( $args[0] ?? '' ) );
	}

	/**
	 * @param array $args  Args.
	 * @param array $flags Flags.
	 * @return array
	 */
	public static function cmd_user_list( $args, $flags ) {
		$users = get_users( array(
			'number' => isset( $flags['number'] ) ? (int) $flags['number'] : 50,
			'role'   => isset( $flags['role'] ) ? (string) $flags['role'] : '',
		) );
		$out = array();
		foreach ( $users as $user ) {
			$out[] = array(
				'ID'           => $user->ID,
				'user_login'   => $user->user_login,
				'display_name' => $user->display_name,
				'user_email'   => $user->user_email,
				'roles'        => implode( ',', $user->roles ),
				'registered'   => $user->user_registered,
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_user_get( $args ) {
		$user = self::resolve_user( $args[0] ?? '' );
		if ( is_wp_error( $user ) ) {
			return $user;
		}
		return array(
			'ID' => $user->ID, 'user_login' => $user->user_login, 'user_email' => $user->user_email,
			'display_name' => $user->display_name, 'roles' => $user->roles, 'registered' => $user->user_registered,
		);
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_user_meta_get( $args ) {
		$user = self::resolve_user( $args[0] ?? '' );
		if ( is_wp_error( $user ) ) {
			return $user;
		}
		return array( 'user_id' => $user->ID, 'key' => $args[1] ?? '', 'value' => get_user_meta( $user->ID, $args[1] ?? '', true ) );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_user_meta_update( $args ) {
		if ( count( $args ) < 3 ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Usage: user meta update <user> <key> <value>' );
		}
		$user = self::resolve_user( $args[0] );
		if ( is_wp_error( $user ) ) {
			return $user;
		}
		update_user_meta( $user->ID, $args[1], $args[2] );
		return array( 'success' => true, 'user_id' => $user->ID, 'key' => $args[1] );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_user_add_role( $args ) {
		$user = self::resolve_user( $args[0] ?? '' );
		if ( is_wp_error( $user ) ) {
			return $user;
		}
		if ( empty( $args[1] ) ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the role to add.' );
		}
		$user->add_role( $args[1] );
		wpxmcp_audit( 'cli user add-role', array( 'user' => $user->ID, 'role' => $args[1] ) );
		return array( 'success' => true, 'user_id' => $user->ID, 'roles' => $user->roles );
	}

	/**
	 * @param array $args Args.
	 * @return array|WP_Error
	 */
	public static function cmd_user_remove_role( $args ) {
		$user = self::resolve_user( $args[0] ?? '' );
		if ( is_wp_error( $user ) ) {
			return $user;
		}
		$user->remove_role( $args[1] ?? '' );
		return array( 'success' => true, 'user_id' => $user->ID, 'roles' => $user->roles );
	}

	/** @return array */
	public static function cmd_menu_list() {
		$out = array();
		foreach ( wp_get_nav_menus() as $menu ) {
			$out[] = array(
				'term_id'   => $menu->term_id,
				'name'      => $menu->name,
				'slug'      => $menu->slug,
				'count'     => $menu->count,
				'locations' => array_keys( array_filter( get_nav_menu_locations(), static function ( $id ) use ( $menu ) {
					return (int) $id === (int) $menu->term_id;
				} ) ),
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array
	 */
	public static function cmd_menu_item_list( $args ) {
		$items = wp_get_nav_menu_items( $args[0] ?? 0 );
		$out   = array();
		foreach ( (array) $items as $item ) {
			$out[] = array(
				'db_id'  => $item->db_id,
				'title'  => $item->title,
				'url'    => $item->url,
				'parent' => $item->menu_item_parent,
				'order'  => $item->menu_order,
				'type'   => $item->type,
			);
		}
		return $out;
	}

	/** @return array */
	public static function cmd_sidebar_list() {
		global $wp_registered_sidebars;
		$out = array();
		foreach ( (array) $wp_registered_sidebars as $id => $sidebar ) {
			$widgets = wp_get_sidebars_widgets();
			$out[]   = array(
				'id'    => $id,
				'name'  => $sidebar['name'],
				'count' => isset( $widgets[ $id ] ) ? count( $widgets[ $id ] ) : 0,
			);
		}
		return $out;
	}

	/**
	 * @param array $args Args.
	 * @return array
	 */
	public static function cmd_widget_list( $args ) {
		$sidebars = wp_get_sidebars_widgets();
		$target   = $args[0] ?? null;
		$out      = array();

		foreach ( $sidebars as $sidebar_id => $widgets ) {
			if ( $target && $sidebar_id !== $target ) {
				continue;
			}
			foreach ( (array) $widgets as $position => $widget_id ) {
				$out[] = array( 'sidebar' => $sidebar_id, 'position' => $position, 'widget' => $widget_id );
			}
		}
		return $out;
	}

	/** @return array */
	public static function cmd_maintenance_status() {
		return array( 'active' => file_exists( ABSPATH . '.maintenance' ) );
	}

	/** @return array */
	public static function cmd_maintenance_activate() {
		file_put_contents( ABSPATH . '.maintenance', '<?php $upgrading = ' . time() . '; ?>' ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		wpxmcp_audit( 'cli maintenance-mode activate' );
		return array( 'success' => true, 'active' => true, 'warning' => 'The site now shows a maintenance page to every visitor.' );
	}

	/** @return array */
	public static function cmd_maintenance_deactivate() {
		if ( file_exists( ABSPATH . '.maintenance' ) ) {
			wp_delete_file( ABSPATH . '.maintenance' );
		}
		return array( 'success' => true, 'active' => false );
	}

	/* ------------------------------------------------------------------ *
	 * Helpers
	 * ------------------------------------------------------------------ */

	/**
	 * Accepts a slug or a full plugin file and returns the plugin file.
	 *
	 * @param string $identifier Slug or file.
	 * @return string|WP_Error
	 */
	private static function resolve_plugin_file( $identifier ) {
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( '' === $identifier ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply the plugin slug or file.' );
		}
		foreach ( array_keys( get_plugins() ) as $file ) {
			if ( $file === $identifier || dirname( $file ) === $identifier || 0 === strpos( $file, $identifier . '/' ) || $file === $identifier . '.php' ) {
				return $file;
			}
		}
		return new WP_Error( 'wpxmcp_not_found', sprintf( 'No installed plugin matching "%s".', $identifier ) );
	}

	/**
	 * Look a user up by id, login or email.
	 *
	 * @param string $identifier Identifier.
	 * @return WP_User|WP_Error
	 */
	private static function resolve_user( $identifier ) {
		if ( '' === $identifier ) {
			return new WP_Error( 'wpxmcp_missing_arg', 'Supply a user id, login or email.' );
		}
		$user = is_numeric( $identifier )
			? get_user_by( 'id', (int) $identifier )
			: ( is_email( $identifier ) ? get_user_by( 'email', $identifier ) : get_user_by( 'login', $identifier ) );

		return $user ? $user : new WP_Error( 'wpxmcp_not_found', sprintf( 'No user matching "%s".', $identifier ) );
	}

	/**
	 * Install a plugin or theme from the WordPress.org repository.
	 *
	 * @param string $kind plugin|theme.
	 * @param string $slug Repository slug.
	 * @return array|WP_Error
	 */
	private static function install_package( $kind, $slug ) {
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/misc.php';

		if ( 'plugin' === $kind ) {
			require_once ABSPATH . 'wp-admin/includes/plugin-install.php';
			$api = plugins_api( 'plugin_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false ) ) );
		} else {
			require_once ABSPATH . 'wp-admin/includes/theme.php';
			$api = themes_api( 'theme_information', array( 'slug' => $slug ) );
		}

		if ( is_wp_error( $api ) ) {
			return $api;
		}

		$upgrader = ( 'plugin' === $kind )
			? new Plugin_Upgrader( new WP_Ajax_Upgrader_Skin() )
			: new Theme_Upgrader( new WP_Ajax_Upgrader_Skin() );

		$result = $upgrader->install( $api->download_link );

		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( false === $result ) {
			return new WP_Error( 'wpxmcp_install_failed', sprintf( 'Installing "%s" failed. The filesystem may not be writable — check wp-content permissions.', $slug ) );
		}

		wpxmcp_audit( 'cli ' . $kind . ' install', array( 'slug' => $slug ) );

		return array(
			'success' => true,
			'kind'    => $kind,
			'slug'    => $slug,
			'version' => isset( $api->version ) ? $api->version : null,
		);
	}
}
